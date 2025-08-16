CREATE TABLE IF NOT EXISTS stations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ocpp_id VARCHAR(50) NOT NULL,
    name VARCHAR(100),
    location JSONB,
    status VARCHAR(20),
    last_heartbeat TIMESTAMP DEFAULT NOW()
);


-- Connectors table to store information about connectors at each station. AKA guns
CREATE TABLE IF NOT EXISTS connectors (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    station_id UUID REFERENCES stations(id),
    connector_number INT,
    status VARCHAR(20),
    blocked BOOLEAN DEFAULT FALSE,
    last_status_change TIMESTAMP DEFAULT NOW(),
    meter_value DECIMAL
);

-- Transactions table to store information about charging sessions
CREATE TABLE IF NOT EXISTS transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    station_id UUID REFERENCES stations(id),
    connector_id UUID REFERENCES connectors(id),
    user_id UUID REFERENCES users(id),
    start_time TIMESTAMP,
    end_time TIMESTAMP,
    energy_consumed DECIMAL,
    status VARCHAR(20)
);

-- Users table to store information about users
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username VARCHAR(50) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    permissions JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Logs table to store logs of OCPP messages
CREATE TABLE IF NOT EXISTS logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    station_id UUID REFERENCES stations(id),
    message_type VARCHAR(20),
    message JSONB,
    timestamp TIMESTAMP DEFAULT NOW()
);
