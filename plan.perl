evms-central-system/
├── src/
│   ├── server.ts            # WebSocket server
│   ├── ocpp/
│   │   ├── router.ts        # Handle OCPP actions
│   │   └── messages.ts      # OCPP message parsing
│   ├── db/
│   │   └── mongo.ts         # MongoDB connection
│   └── types/
│       └── ocpp.ts          # Type definitions for OCPP messages
├── tsconfig.json
