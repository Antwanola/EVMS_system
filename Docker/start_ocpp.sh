#!/bin/bash

echo "🚀 Starting OCPP Gateway..."

# Stop any running containers
docker-compose down

# Build and start in detached mode
docker-compose up --build -d

# Wait a bit for DB to be ready
echo "⏳ Waiting for database to be ready..."
sleep 5

# Run Prisma migrations inside the app container
echo "📦 Running Prisma migrations..."
docker exec -it ocpp_gateway npx prisma migrate deploy

echo "✅ OCPP Gateway is up and running at http://localhost:3000"
