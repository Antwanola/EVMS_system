src/
├── server.ts                 # Main application entry
├── services/
│   ├── ocpp-server.ts       # Core OCPP WebSocket server
│   ├── database.ts          # Prisma database service
│   ├── redis.ts             # Redis caching service
│   ├── api-gateway.ts       # REST API gateway
│   └── charge-point-manager.ts
├── handlers/
│   └── ocpp-message-handler.ts
├── types/
│   └── ocpp.types.ts        # TypeScript definitions
├── utils/
│   └── logger.ts            # Winston logger
└── middleware/
    └── validation.ts        # Request validation

prisma/
├── schema.prisma            # Database schema
└── seed.ts                  # Database seeding





smartcash
8029050270
ifayin