export async function ensureStationSchema(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS cc_phone_stations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('webrtc','deskphone','sip')),
      phone_id UUID UNIQUE REFERENCES hp_phones(id) ON DELETE CASCADE,
      owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      shared BOOLEAN NOT NULL DEFAULT false,
      enabled BOOLEAN NOT NULL DEFAULT true,
      sip_username TEXT,
      connection_id TEXT,
      registration_status TEXT NOT NULL DEFAULT 'unknown',
      registration_checked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK ((kind='deskphone') = (phone_id IS NOT NULL))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS cc_station_webrtc_owner ON cc_phone_stations(owner_id)
      WHERE kind='webrtc';
    CREATE UNIQUE INDEX IF NOT EXISTS cc_station_sip_identity ON cc_phone_stations(lower(sip_username))
      WHERE kind IN ('deskphone','sip') AND sip_username IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS cc_station_sip_connection ON cc_phone_stations(connection_id)
      WHERE kind IN ('deskphone','sip') AND connection_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS cc_extension_pools (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT NOT NULL,
      digits INT NOT NULL CHECK (digits IN (3,4,5)),
      start_number INT NOT NULL, end_number INT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK (start_number>=power(10,digits-1) AND end_number<power(10,digits) AND end_number>=start_number)
    );
    CREATE TABLE IF NOT EXISTS cc_extension_pool_types (
      target_type TEXT PRIMARY KEY CHECK (target_type IN ('user','queue','phone')),
      pool_id UUID NOT NULL UNIQUE REFERENCES cc_extension_pools(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS cc_extension_assignments (
      number TEXT PRIMARY KEY CHECK (number ~ '^[1-9][0-9]{2,4}$'),
      pool_id UUID NOT NULL REFERENCES cc_extension_pools(id) ON DELETE RESTRICT,
      target_type TEXT NOT NULL CHECK (target_type IN ('user','queue','phone')),
      user_id TEXT UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      queue_id TEXT UNIQUE REFERENCES cc_queues(id) ON DELETE CASCADE,
      station_id UUID UNIQUE REFERENCES cc_phone_stations(id) ON DELETE CASCADE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK (num_nonnulls(user_id,queue_id,station_id)=1),
      CHECK ((target_type='user')=(user_id IS NOT NULL)),
      CHECK ((target_type='queue')=(queue_id IS NOT NULL))
    );
    CREATE TABLE IF NOT EXISTS cc_station_audit (
      id BIGSERIAL PRIMARY KEY, actor_id TEXT, action TEXT NOT NULL,
      target_id TEXT, detail JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS cc_station_leases (
      station_id UUID PRIMARY KEY REFERENCES cc_phone_stations(id) ON DELETE RESTRICT,
      agent_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      auth_session_id TEXT NOT NULL,
      endpoint_id UUID UNIQUE REFERENCES cc_voice_endpoints(id) ON DELETE CASCADE,
      generation UUID NOT NULL DEFAULT gen_random_uuid(),
      purpose TEXT NOT NULL DEFAULT 'work' CHECK (purpose IN ('work','identify')),
      claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL,
      test_call_id TEXT
    );
    CREATE TABLE IF NOT EXISTS cc_voice_login_choices (
      auth_session_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      station_id UUID REFERENCES cc_phone_stations(id) ON DELETE SET NULL,
      kind TEXT NOT NULL CHECK (kind IN ('webrtc','deskphone','sip','none')),
      pending_selection BOOLEAN NOT NULL DEFAULT true,
      selected_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE cc_voice_login_choices ADD COLUMN IF NOT EXISTS pending_selection BOOLEAN NOT NULL DEFAULT true;
    ALTER TABLE cc_voice_endpoints ADD COLUMN IF NOT EXISTS station_id UUID REFERENCES cc_phone_stations(id) ON DELETE SET NULL;
    DO $$ BEGIN
      IF EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='cc_voice_endpoints'::regclass
        AND conname='cc_voice_endpoints_station_id_fkey' AND confdeltype<>'n') THEN
        ALTER TABLE cc_voice_endpoints DROP CONSTRAINT cc_voice_endpoints_station_id_fkey;
        ALTER TABLE cc_voice_endpoints ADD CONSTRAINT cc_voice_endpoints_station_id_fkey FOREIGN KEY(station_id) REFERENCES cc_phone_stations(id) ON DELETE SET NULL;
      END IF;
    END $$;
    ALTER TABLE cc_voice_endpoints ADD COLUMN IF NOT EXISTS credential_owned BOOLEAN NOT NULL DEFAULT true;
    ALTER TABLE cc_voice_endpoints ADD COLUMN IF NOT EXISTS outbound_identity TEXT NOT NULL DEFAULT 'personal';
    ALTER TABLE cc_voice_endpoints DROP CONSTRAINT IF EXISTS cc_voice_endpoints_kind_check;
    ALTER TABLE cc_voice_endpoints ADD CONSTRAINT cc_voice_endpoints_kind_check CHECK (kind IN ('web','ios','android','deskphone','sip'));
  `);
}
