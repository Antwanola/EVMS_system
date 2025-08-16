evms-central-system/
├── src/
│   ├── server.ts              # WebSocket server
│   ├── ocpp/
│   │   ├── router.ts          # Handle OCPP actions
│   │   └── messages.ts        # OCPP message parsing
│   ├── db/
│   │   └── mongo.ts           # MongoDB connection
│   └── types/
│       └── ocpp.ts            # Type definitions for OCPP messages
├── tsconfig.json
├── Docker/
│   ├── Dockerfile             # Defines container build for OCPP server
│   ├── docker-compose.yml     # Compose file to run app + MongoDB
│   ├── start_ocpp.sh          # Script to start server inside container
│   └── deploy_ocpp.sh         # Deployment helper script
