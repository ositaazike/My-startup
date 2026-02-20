# FuelGuard Africa — Production-Grade Architecture and Implementation Specification

---

## 1. Executive Architecture Summary

### System Overview
FuelGuard Africa is a distributed, offline-resilient IoT + SaaS platform designed for harsh Nigerian operating conditions. It employs a **5-layer hierarchical architecture** with cryptographic tamper-evidence, blockchain-inspired audit trails, and aggressive offline-first data strategies.

```text
┌─────────────────────────────────────────────────────────────┐
│                    CLOUD LAYER (AWS af-south-1)            │
│  ┌──────────────┐  ┌──────────────┐  ┌─────────────────┐   │
│  │   AWS IoT    │  │  EKS Cluster │  │   RDS Postgres  │   │
│  │    Core      │  │   (Go/Node)  │  │  (Multi-tenant) │   │
│  └──────────────┘  └──────────────┘  └─────────────────┘   │
└──────────────────────┬──────────────────────────────────────┘
                       │ MQTT over TLS 1.3 / HTTPS (Sync)
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                  EDGE LAYER (Station Hub)                  │
│  ┌──────────────┐  ┌──────────────┐  ┌─────────────────┐   │
│  │  Local API   │  │  PostgreSQL  │  │   LTE Failover  │   │
│  │   (Nginx)    │  │   (Edge DB)  │  │   (Quectel)     │   │
│  └──────────────┘  └──────────────┘  └─────────────────┘   │
└──────────────────────┬──────────────────────────────────────┘
                       │ MQTT over LAN / Serial
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                  DEVICE LAYER (Per Pump)                   │
│  ┌──────────────┐  ┌──────────────┐  ┌─────────────────┐   │
│  │ ESP32-S3     │  │ ATECC608A    │  │  Opto-Isolated  │   │
│  │  (FreeRTOS)  │  │ (Secure Key) │  │  Pulse Counter  │   │
│  └──────────────┘  └──────────────┘  └─────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                 MOBILE LAYER (Flutter)                     │
│  Owner/Manager App ───────► Local Edge (WiFi) or Cloud     │
└─────────────────────────────────────────────────────────────┘
```

### Engineering Decisions for Nigerian Context
- **Power resilience**: 12V UPS + 8-hour LiFePO4 backup and graceful shutdown scripts.
- **Heat/dust tolerance**: IP65 enclosure, conformal coating, no moving parts.
- **Corruption mitigation**: ATECC608A hardware attestation + immutable hash chain.
- **Network resilience**: store-and-forward queues, LZ4 compression, SMS fallback.

---

## 2. Detailed Technical Specifications

### 2.1 IoT Firmware (ESP32-S3)

#### Hardware Stack
- MCU: ESP32-S3-WROOM-1
- Security: ATECC608A-TNGTLS
- Input: PC817 optocoupler pulse counting
- Sensors: BME280 + Hall tamper sensor
- Power: 12V PSU + supercapacitor safe shutdown

#### FreeRTOS Task Model
```text
PulseISR (high priority)    -> Interrupt pulse counter
StateMachine (normal)       -> IDLE → ARMED → DISPENSING → SYNC
CryptoEngine (high)         -> ATECC608A signatures
NetworkMgr (normal)         -> MQTT + local queue
TamperWatch (low)           -> Case switch + temperature
```

#### Core Pseudocode
```c
void IRAM_ATTR pulse_isr() {
    uint32_t now = xTaskGetTickCountFromISR();
    pulse_count++;
    last_pulse_time = now;

    if (state == IDLE && pulse_count > 3) {
        state = ARMED;
        session_start_time = now;
    }
    if (state == ARMED) {
        state = DISPENSING;
    }
}

void state_machine_task(void *pv) {
    while(1) {
        switch(state) {
            case DISPENSING:
                if (xTaskGetTickCount() - last_pulse_time > pdMS_TO_TICKS(5000)) {
                    finalize_transaction();
                    state = FINALIZE;
                }
                break;

            case FINALIZE:
                Transaction tx = {
                    .device_id = DEVICE_UUID,
                    .pulse_count = pulse_count,
                    .timestamp = get_rtc_time(),
                    .prev_hash = last_tx_hash,
                    .liters = pulse_count * PULSE_CALIBRATION
                };

                tx.signature = atecc_sign(sha256(tx));
                tx.tx_hash = sha256(tx.signature + tx.prev_hash);

                if (mqtt_connected) {
                    publish_transaction(tx);
                    state = IDLE;
                } else {
                    spiffs_append(tx);
                    state = SYNC_PENDING;
                }
                pulse_count = 0;
                break;
        }
        vTaskDelay(100);
    }
}
```

#### MQTT Topics
```text
fuelguard/{tenant_id}/{station_id}/{device_id}/telemetry
fuelguard/{tenant_id}/{station_id}/{device_id}/status
fuelguard/{tenant_id}/{station_id}/{device_id}/tamper
fuelguard/{tenant_id}/{station_id}/{device_id}/config
fuelguard/{tenant_id}/{station_id}/{device_id}/commands/ota
fuelguard/{tenant_id}/{station_id}/{device_id}/commands/config
```

### 2.2 Edge Hub (Station)

#### Hardware
- Compute Module 4 (8GB) or industrial x86 edge box
- 256GB SSD + 32GB SD (OS)
- Dual Ethernet + Quectel LTE dual-SIM failover
- 12V UPS controller + 10,000mAh LiFePO4

#### Docker Compose Services
```yaml
version: '3.8'
services:
  edge-db:
    image: postgres:15-alpine
  redis:
    image: redis:7-alpine
  local-api:
    build: ./local-api
  sync-engine:
    build: ./sync-engine
  nginx:
    image: nginx:alpine
```

#### Local DB Schema (Excerpt)
```sql
CREATE TABLE devices (
    device_id UUID PRIMARY KEY,
    pump_code VARCHAR(10) NOT NULL,
    calibration_factor DECIMAL(10,6) DEFAULT 0.07988,
    last_seen TIMESTAMP,
    public_key TEXT,
    firmware_version VARCHAR(20)
);

CREATE TABLE local_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id UUID REFERENCES devices(device_id),
    pulse_count INTEGER NOT NULL,
    liters DECIMAL(10,2),
    amount_naira DECIMAL(12,2),
    timestamp TIMESTAMP NOT NULL,
    tx_hash VARCHAR(64) UNIQUE NOT NULL,
    signature TEXT NOT NULL,
    synced BOOLEAN DEFAULT FALSE,
    sync_attempts INTEGER DEFAULT 0
);
```

#### Offline-first Policy
- Island mode after 3 failed 30-second cloud pings.
- Queue up to 10,000 transactions (~7 days).
- Mobile app can switch to edge endpoint (`192.168.100.1:443`).
- Reconnect with parallelized delta sync.

### 2.3 Cloud Backend (AWS af-south-1)

- API Gateway + EKS microservices + AWS IoT Core.
- Multi-AZ PostgreSQL with Redis for hot cache.
- Kinesis + Lambda for stream anomaly detection.
- Row-level security (RLS) for tenant isolation.

#### Tenant Isolation Snippet
```sql
ALTER TABLE stations ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON stations
USING (tenant_id = current_setting('app.current_tenant')::UUID);
```

### 2.4 Mobile App (Flutter)
- Clean Architecture + Bloc.
- Drift/SQLite local cache with pending operations queue.
- Sync strategy: local-first read, background cloud reconciliation.

### 2.5 Fraud Prevention
- Hash-chain verification with `prev_tx_hash` and ECDSA signature validation.
- Pump-activity-outside-shift detection.
- Statistical anomaly detection (3-sigma + impossible flow rates).

### 2.6 Stock Reconciliation Engine
- Opening + deliveries - sales = theoretical stock.
- Compare with physical dip.
- Alert threshold above ±0.3% variance.

---

## 3. Data Model (Cloud)

Core entities:
- `tenants`
- `stations`
- `users`
- `devices`
- `tanks`
- `pump_tank_mappings`
- `shifts`
- `transactions`
- `dip_readings`
- `deliveries`
- `alerts`
- `audit_logs`

Recommended controls:
- Immutable transaction hash (`tx_hash`) and signature storage.
- Audit trail for all mutation operations.
- Indexed access paths by station/time and unresolved alert status.

---

## 4. API Contracts

### Auth
- `POST /v1/auth/login`
- `POST /v1/auth/refresh`

### Transactions
- `POST /v1/transactions/bulk`
- `GET /v1/transactions?station_id=...&start=...&end=...`

### Shifts
- `POST /v1/shifts`
- `PATCH /v1/shifts/{shift_id}/close`
- `GET /v1/shifts/{shift_id}/variance`

### Webhooks
- Outbound signed payloads with `X-Webhook-Signature: sha256=...`

---

## 5. Security Framework

- mTLS 1.3 device-cloud.
- Certificate pinning in app.
- Signed OTA updates + rollback prevention.
- Key rotation policy (device annual, JWT semi-annual, cert 90-day renewal).
- Retention: transaction data (7y), audit logs (10y immutable archive).

---

## 6. DevOps and Deployment

### CI/CD
- GitHub Actions pipeline:
  - Tests + race detector
  - SAST / semgrep
  - Docker build + ECR push
  - EKS deployment + smoke tests

### Infra as Code
- Terraform modules for VPC, EKS, RDS, IoT, S3.
- Environments: `dev`, `staging`, `prod`.

### Observability
- Metrics: Prometheus + Grafana
- Logs: Fluent Bit → CloudWatch/OpenSearch
- Alerts: PagerDuty + SMS escalation

---

## 7. Cost and Unit Economics

### BOM Targets
- Pump device target: **~$25.50**
- Edge hub target: **~$380**
- Cloud operating cost per station: **~$64.50/mo**

### Pricing Strategy
- Flat model alone underperforms at low scale.
- Per-liter and hybrid models provide healthy gross margin.
- Break-even depends on station count and pricing mix.

---

## 8. Scaling Strategy

- **Phase 1 (10 stations):** single DB, manual edge provisioning.
- **Phase 2 (100):** Multi-AZ, EKS nodes, Redis cluster.
- **Phase 3 (1,000):** regional sharding and ingestion separation.
- **Phase 4 (10,000):** active-active multi-region, Aurora Global DB.

Database tactics:
- Monthly partitioning for `transactions`.
- Archive >1 year to S3 Parquet.
- Read replicas and PgBouncer pooling.

---

## 9. Risk and Mitigation

Technical and business controls include:
- Heat-tolerant hardware profiles.
- Offline continuity and SMS fallback.
- Automated cert rotation and backup drills.
- Anti-fraud process controls (technician rotation, verifiable dip evidence).

---

## 10. Final Implementation Checklist

### Phase 1 (Months 1-3)
- Hardware MVP batch
- Firmware base features
- Edge local services
- Basic cloud APIs + auth
- Pilot stations in Lagos

### Phase 2 (Months 4-6)
- Hardening for enclosure and environment
- Billing + reporting + multi-tenancy
- Offline mobile mode + biometric auth
- Compliance groundwork

### Phase 3 (Months 7-12)
- Local assembly partners
- Full CI/CD and staging
- Predictive and reconciliation enhancements
- Regional expansion playbook

### Phase 4 (Year 2)
- AI forecasting and advanced fraud detection
- Banking/compliance integrations
- Gen2 hardware and regional expansion

---

This specification is implementation-ready and optimized for the realities of fuel retail operations in Nigeria: unstable power, intermittent network coverage, environmental stress, and high fraud pressure.
