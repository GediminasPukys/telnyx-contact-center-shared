import { randomBytes, createHash } from 'node:crypto';
import { isIPv4 } from 'node:net';
import { createPhoneSipConnection, deletePhoneSipConnection } from '../hardphones/credentials.mjs';
import { enrollProvisioningPhone, provisioningCredentials, polycomBootstrapParameters } from '../hardphones/provisioning-access.mjs';
import { polycomRegistrationConfig, audiocodesPhoneConfig, yealinkPhoneConfig } from '../hardphones/config-generators.mjs';
import { syncStationInventory, telephonyError as fail } from './extensions.mjs';

const hash = s => createHash('sha256').update(String(s)).digest('hex');
const local = ip => isIPv4(ip || '') && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
export function validateDesktopDevice(p) {
  if(!p || !/^[a-f0-9]{12}$/.test(p.mac || '') || !local(p.ip_address) || !local(p.localHost)
    || !({polycom:['VVX 300'],audiocodes:['420HD','440HD'],yealink:['T22P']})[p.vendor]?.includes(p.model)) throw fail(400,'Unsupported local phone');
}
export function desktopMayConfigure(phone,station,user,admin) {
  if(!station?.enabled || (!admin && station.owner_id!==String(user.id))) throw fail(403,'Ask an administrator to assign this phone to you');
  if(phone.local_bridge_id && phone.local_bridge_id!==user.desktopBridgeId) throw fail(409,'This phone has another controller. Ask an administrator to release it first.');
}
export function desktopRelayUrl() {
  const base=process.env.DESKTOP_BRIDGE_WS_URL || process.env.WS_BASE_URL || process.env.STREAMING_WS_URL;
  if(base) {const u=new URL(base);u.protocol=u.protocol==='https:'?'wss:':u.protocol==='http:'?'ws:':u.protocol;
    if(!u.pathname.endsWith('/hardphone-bridge'))u.pathname=u.pathname.replace(/\/$/,'')+'/hardphone-bridge';return u.href;}
  const u=new URL(process.env.NEXTAUTH_URL || process.env.APP_BASE_URL);
  u.protocol=u.protocol==='http:'?'ws:':'wss:';u.port=process.env.STREAMING_WS_PORT || '3001';u.pathname='/hardphone-bridge';return u.href;
}

export async function enrollDesktop(pool,user,body) {
  if(!/^[a-f0-9-]{36}$/.test(body.computerId || ''))throw fail(400,'Invalid desktop identity');
  if(body.bridgeId) {
    const row=(await pool.query('SELECT * FROM hp_local_bridges WHERE bridge_id=$1',[body.bridgeId])).rows[0];
    if(!row || typeof body.bridgeToken!=='string' || row.token_hash!==hash(body.bridgeToken))throw fail(403,'Desktop enrollment is no longer valid');
    // Knowing an old token alone cannot change ownership or expose inventory.
    if(row.created_by && row.created_by!==String(user.id))throw fail(403,'This desktop belongs to another account');
    return {bridgeId:row.bridge_id,bridgeToken:body.bridgeToken,relayUrl:desktopRelayUrl()};
  }
  const id=`desktop-${body.computerId}`,token=randomBytes(32).toString('hex');
  await pool.query(`INSERT INTO hp_local_bridges(bridge_id,label,token_hash,status,metadata,created_by)
    VALUES($1,$2,$3,'offline',$4,$5)`,[id,String(body.computerName || 'Contact Center Desktop').slice(0,80),hash(token),JSON.stringify({desktop:true,computerId:body.computerId}),String(user.id)]);
  return {bridgeId:id,bridgeToken:token,relayUrl:desktopRelayUrl()};
}

export async function prepareDesktopPhone(pool,user,body,{admin=false,createConnection=createPhoneSipConnection}={}) {
  validateDesktopDevice(body.phone);
  const managedAdminPassword=process.env.TELNYX_PHONE_ADMIN_PASSWORD;
  if(!managedAdminPassword)throw fail(409,'Ask an administrator to configure TELNYX_PHONE_ADMIN_PASSWORD');
  if(managedAdminPassword.length>32 || /[;\r\n]/.test(managedAdminPassword))throw fail(409,'The configured administrator password is not compatible with these phone models');
  const bridge=(await pool.query('SELECT * FROM hp_local_bridges WHERE bridge_id=$1',[body.bridgeId])).rows[0];
  if(!bridge || bridge.token_hash!==hash(body.bridgeToken) || (bridge.created_by && bridge.created_by!==String(user.id)))throw fail(403,'Invalid desktop enrollment');
  const db=await pool.connect();let connection,commitStarted=false;
  try {
    await db.query('BEGIN');
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended('cc:station-leases',0))");
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended('cc:extension-directory',0))");
    let phone=(await db.query('SELECT * FROM hp_phones WHERE mac=$1 FOR UPDATE',[body.phone.mac])).rows[0];
    if(!phone) {
      if((await db.query('SELECT 1 FROM hp_phones WHERE created_by=$1',[String(user.id)])).rowCount>=8&&!admin)throw fail(409,'Ask an administrator to add more phones');
      connection=await createConnection({mac:body.phone.mac,vendor:body.phone.vendor,model:body.phone.model});
      phone=(await db.query(`INSERT INTO hp_phones(mac,vendor,model,phone_name,agent_id,sip_username,sip_password,telnyx_connection_id,telnyx_credential_id,settings,created_by,provisioning_state)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'{}',$5,'pending') RETURNING *`,
      [body.phone.mac,body.phone.vendor,body.phone.model,`${user.first_name || 'My'} ${body.phone.model}`,String(user.id),connection.sip_username,connection.sip_password,connection.connection_id||connection.id,connection.id])).rows[0];
    }
    if(phone.vendor!==body.phone.vendor || phone.model!==body.phone.model)throw fail(409,'The discovered model does not match inventory');
    await syncStationInventory(db);
    const station=(await db.query('SELECT * FROM cc_phone_stations WHERE phone_id=$1 FOR UPDATE',[phone.id])).rows[0];
    desktopMayConfigure(phone,station,{...user,desktopBridgeId:body.bridgeId},admin);
    // Never steal even the caller's own work session while changing SIP settings.
    if((await db.query('SELECT 1 FROM cc_station_leases WHERE station_id=$1',[station.id])).rowCount)throw fail(409,'Release this phone in the phone picker before configuring it');
    const pending=phone.settings?.desktop_setup;
    if(pending && Date.parse(pending.expires)>Date.now())throw fail(409,'Phone setup is already in progress');
    let extension=(await db.query('SELECT number FROM cc_extension_assignments WHERE station_id=$1',[station.id])).rows[0]?.number;
    if(!extension) {
      const range=(await db.query("SELECT p.* FROM cc_extension_pools p JOIN cc_extension_pool_types t ON t.pool_id=p.id WHERE t.target_type='phone'")).rows[0];
      if(!range)throw fail(409,'Ask an administrator to define a phone extension pool');
      extension=(await db.query(`SELECT n::text AS number FROM generate_series($1::int,$2::int) n
        WHERE NOT EXISTS(SELECT 1 FROM cc_extension_assignments a WHERE a.number=n::text)
        AND NOT EXISTS(SELECT 1 FROM users u WHERE u.extension=n::text) ORDER BY n LIMIT 1`,[range.start_number,range.end_number])).rows[0]?.number;
      if(!extension)throw fail(409,'The phone extension pool is full');
      await db.query("INSERT INTO cc_extension_assignments(number,pool_id,target_type,station_id) VALUES($1,$2,'phone',$3)",[extension,range.id,station.id]);
    }
    const token=randomBytes(32).toString('hex');
    const setup={tokenHash:hash(token),passwordHash:hash(managedAdminPassword),actor:String(user.id),bridgeId:body.bridgeId,expires:new Date(Date.now()+10*60e3).toISOString(),ip:body.phone.ip_address,host:body.phone.localHost};
    await db.query("UPDATE hp_phones SET settings=jsonb_set(COALESCE(settings,'{}'),'{desktop_setup}',$2::jsonb) WHERE id=$1",[phone.id,JSON.stringify(setup)]);
    const proposed={...phone,admin_password:managedAdminPassword,extension,settings:{...phone.settings,cti_mode:'desktop_bridge',sip_controller_host:body.phone.localHost,sip_controller_port:5070}};
    const enrollment=await enrollProvisioningPhone(db,proposed);
    const config=({polycom:polycomRegistrationConfig,audiocodes:audiocodesPhoneConfig,yealink:yealinkPhoneConfig})[phone.vendor](proposed,{baseUrl:enrollment.base_url,credential:provisioningCredentials(proposed,enrollment)});
    commitStarted=true;await db.query('COMMIT');
    return {phone:{id:phone.id,mac:phone.mac,vendor:phone.vendor,model:phone.model,sip_username:phone.sip_username,extension,name:phone.phone_name},setupToken:token,
      config,managedAdminPassword,bootstrap:phone.vendor==='polycom'?polycomBootstrapParameters(proposed,enrollment):null,baseUrl:enrollment.base_url};
  } catch(error) {await db.query('ROLLBACK');if(connection&&!commitStarted)await deletePhoneSipConnection(connection.id).catch(()=>{});throw error;}
  finally {db.release();}
}

export async function finishDesktopPhone(pool,user,body) {
  const db=await pool.connect();
  try {
    await db.query('BEGIN');await db.query("SELECT pg_advisory_xact_lock(hashtextextended('cc:station-leases',0))");
    const phone=(await db.query('SELECT * FROM hp_phones WHERE id=$1 FOR UPDATE',[body.phoneId])).rows[0];
    const s=phone?.settings?.desktop_setup;
    if(!s || s.actor!==String(user.id) || s.tokenHash!==hash(body.setupToken))throw fail(403,'Invalid phone setup session');
    if(body.success) {
      if(s.passwordHash!==hash(process.env.TELNYX_PHONE_ADMIN_PASSWORD))throw fail(409,'The managed password changed during setup. Repeat phone configuration.');
      if(Date.parse(s.expires)<Date.now())throw fail(409,'Phone setup expired. Discover the phone again.');
      if((await db.query('SELECT 1 FROM cc_station_leases l JOIN cc_phone_stations p ON p.id=l.station_id WHERE p.phone_id=$1',[phone.id])).rowCount)throw fail(409,'Phone is in use');
      await db.query(`UPDATE hp_phones SET local_bridge_id=$2,ip_address=$3,last_ip=$3,
        settings=(settings-'desktop_setup') || $4::jsonb,admin_password=$5,updated_at=now() WHERE id=$1`,[phone.id,s.bridgeId,s.ip,JSON.stringify({cti_mode:'desktop_bridge',sip_controller_host:s.host,sip_controller_port:5070}),process.env.TELNYX_PHONE_ADMIN_PASSWORD]);
    } else await db.query("UPDATE hp_phones SET settings=settings-'desktop_setup' WHERE id=$1",[phone.id]);
    await db.query("INSERT INTO cc_station_audit(actor_id,action,target_id,detail) VALUES($1,$2,$3,$4)",[String(user.id),body.success?'desktop_phone_enrolled':'desktop_phone_setup_failed',phone.id,JSON.stringify({bridgeId:s.bridgeId})]);
    await db.query('COMMIT');return {ok:true};
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
