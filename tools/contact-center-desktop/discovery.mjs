import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { isIPv4, createConnection } from 'node:net';
import { deviceWebRequest } from '../../lib/hardphones/device-web.mjs';

const exec = promisify(execFile);
const int = ip => ip.split('.').reduce((n, part) => (n * 256 + Number(part)) >>> 0, 0);
const address = n => [24,16,8,0].map(s => (n >>> s) & 255).join('.');
export const privateAddress = ip => isIPv4(ip) && (/^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip));

// Only directly connected private LANs. Never scan a VPN, public range or an
// address supplied by a web page. Large enterprise VLANs get a bounded window.
export function localNetworks(interfaces = os.networkInterfaces()) {
  return Object.entries(interfaces).filter(([name]) => !/^(lo|utun|tun|tap|docker|veth|vmnet|vbox|tailscale|wg)|vpn|loopback/i.test(name))
    .flatMap(([name, values]) => values.filter(v => !v.internal && v.family === 'IPv4' && privateAddress(v.address) && isIPv4(v.netmask))
      .map(v => ({ name, host:v.address, mask:v.netmask, network:(int(v.address) & int(v.netmask)) >>> 0 })));
}
export function inNetwork(ip, network) { return privateAddress(ip) && ((int(ip) & int(network.mask)) >>> 0) === network.network; }
export function scanAddresses(networks) {
  return [...new Set(networks.flatMap(n => {
    const mask = int(n.mask), size = 0xffffffff - mask;
    const start = size > 1023 ? (int(n.host) & 0xffffff00) >>> 0 : n.network;
    return Array.from({length:Math.min(size-1,254)}, (_,i) => address(start+i+1)).filter(ip => ip !== n.host && inNetwork(ip,n));
  }))].slice(0,1024);
}
export function parseNeighbors(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const ip = line.match(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/)?.[1];
    const mac = line.match(/\b([a-f\d]{1,2}(?:[:-][a-f\d]{1,2}){5})\b/i)?.[1]
      ?.split(/[:-]/).map(v => v.padStart(2,'0')).join('').toLowerCase();
    if (privateAddress(ip || '') && mac && !/^(?:ff|00){6}$/.test(mac)) rows.push({ip,mac});
  }
  return rows;
}
export async function neighbors() {
  try { return parseNeighbors((await exec(process.platform==='win32'?'arp':process.platform==='darwin'?'/usr/sbin/arp':'arp',process.platform==='win32'?['-a']:['-an'],{timeout:4000,maxBuffer:256*1024})).stdout); }
  catch (error) { console.warn('LAN neighbor lookup unavailable:',error.code || error.name);return []; }
}
export function detectVendor(response, mac='') {
  const text = `${response.raw}\n${JSON.stringify(response.headers)}`;
  if (/polycom|polycom\/|\bVVX\b/i.test(text)) return 'polycom';
  if (/audiocodes|400HD|420HD|440HD|URL=mainform\.cgi(?:\?go=mainframe\.htm|\/index\.htm)/i.test(text)) return 'audiocodes';
  if (/yealink|\/servlet\?p=login&q=loginForm&jumpto=status/i.test(text)) return 'yealink';
  return ({'0004f2':'polycom','64167f':'polycom','00908f':'audiocodes','001565':'yealink','805ec0':'yealink'})[mac.slice(0,6)] || null;
}
async function managementPortOpen(ip,port) {
  return new Promise(resolve=>{
    const socket=createConnection({host:ip,port});let ended=false;
    function done(open){if(ended)return;ended=true;socket.destroy();resolve(open);}
    socket.setTimeout(400,()=>done(false));socket.once('connect',()=>done(true));socket.once('error',()=>done(false));
  });
}
export async function discoverPhones({ interfaces, request=deviceWebRequest, readNeighbors=neighbors, onProgress=()=>{} } = {}) {
  const networks=localNetworks(interfaces), before=await readNeighbors();
  const targets=[...new Set([...before.filter(n=>networks.some(net=>inNetwork(n.ip,net))).map(n=>n.ip),...scanAddresses(networks)])].slice(0,1024);
  const found=[]; let next=0, done=0;
  await Promise.all(Array.from({length:16},async()=>{
    while(next<targets.length) {
      const ip=targets[next++];
      const mac=before.find(n=>n.ip===ip)?.mac || '';
      for(const protocol of detectVendor({raw:'',headers:{}},mac)==='yealink'?['http','https']:['https','http']) {
        try {
          // A short TCP probe separates absent hosts from slow legacy TLS.
          // It does not send credentials or application data.
          if(request===deviceWebRequest&&!await managementPortOpen(ip,protocol==='https'?443:80))continue;
          const response=await request({ip_address:ip,settings:{management_protocol:protocol}},'/',{timeoutMs:detectVendor({raw:'',headers:{}},mac)?3500:2500});
          const vendor=detectVendor(response,mac);
          if(vendor) {found.push({candidateId:randomUUID(),ip_address:ip,vendor,mac,protocol,certificate_fingerprint:response.certificateFingerprint || null,
            localHost:networks.find(n=>inNetwork(ip,n))?.host}); break;}
        } catch { /* Closed port, other device, or LAN permission not granted. */ }
      }
      onProgress({done:++done,total:targets.length});
    }
  }));
  const after=await readNeighbors();
  for(const p of found) p.mac=after.find(n=>n.ip===p.ip_address)?.mac || p.mac;
  return {phones:found,networks:networks.map(n=>({name:n.name,host:n.host})),scanned:targets.length,
    limited:networks.some(n=>0xffffffff-int(n.mask)>255)};
}
