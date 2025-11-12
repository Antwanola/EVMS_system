#!/bin/bash

# start-ocpp.sh
echo -e "\033[32m🚀 Starting OCPP Gateway...\033[0m"

# Stop any running containers
echo -e "\033[33m🛑 Stopping existing containers...\033[0m"
docker compose down --remove-orphans

# Build and start containers
echo -e "\033[36m🔨 Building and starting containers...\033[0m"
docker compose up --build -d

# Wait for containers to start
echo -e "\033[33m⏳ Waiting for containers to start...\033[0m"
sleep 15

# Check if containers are running
echo -e "\033[36m🔍 Checking container status...\033[0m"
docker compose ps --format "table {{.Service}}\t{{.State}}"

# Check if Traefik is running properly
echo -e "\033[36m🔍 Checking Traefik status...\033[0m"
traefikStatus=$(docker compose ps traefik --format "{{.State}}")

if [ "$traefikStatus" != "running" ]; then
    echo -e "\033[31m❌ Traefik is not running. Checking logs...\033[0m"
    docker compose logs traefik | tail -20
    echo -e "\033[33m⚠️  Continuing without Traefik...\033[0m"
fi

# Wait for database to be ready and run migrations
echo -e "\033[36m📦 Waiting for database and running Prisma migrations...\033[0m"
echo -e "\033[37m   Checking database connectivity...\033[0m"

dbReady=false
dbAttempts=0
maxDbAttempts=30

while [ $dbAttempts -lt $maxDbAttempts ]; do
    ((dbAttempts++))
    echo -e "\033[37m   Database check attempt $dbAttempts/$maxDbAttempts...\033[0m"

    if docker compose exec -T postgres pg_isready -U postgres -d ocpp > /dev/null 2>&1; then
        echo -e "\033[32m✅ Database is ready!\033[0m"
        dbReady=true
        break
    fi

    sleep 2
done

if [ "$dbReady" = false ]; then
    echo -e "\033[31m❌ Database failed to become ready\033[0m"
    docker compose logs postgres
    exit 1
fi

# Wait a bit more for the OCPP server to be fully up
echo -e "\033[33m⏳ Waiting for OCPP server to initialize...\033[0m"
sleep 5

# Run Prisma migrations with retries
maxAttempts=5
attempt=1

while [ $attempt -le $maxAttempts ]; do
    echo -e "\033[37m   Migration attempt $attempt/$maxAttempts...\033[0m"

    docker compose exec -T ocpp-server npx prisma migrate deploy 2>&1 | tee /tmp/migration.log

    if grep -q "No pending migrations to apply" /tmp/migration.log; then
        echo -e "\033[32m✅ No pending migrations. Database is up to date!\033[0m"
        break
    elif grep -q "applied" /tmp/migration.log; then
        echo -e "\033[32m✅ Prisma migrations completed successfully!\033[0m"
        break
    elif grep -q "already applied" /tmp/migration.log; then
        echo -e "\033[32m✅ All migrations already applied!\033[0m"
        break
    elif [ $attempt -eq $maxAttempts ]; then
        echo -e "\033[31m❌ Migration attempt $attempt failed\033[0m"
        echo -e "\033[31mError output:\033[0m"
        cat /tmp/migration.log
    else
        echo -e "\033[33m⚠️  Migration attempt $attempt failed, retrying...\033[0m"
        sleep 5
    fi

    ((attempt++))
done

if [ $attempt -gt $maxAttempts ]; then
    echo -e "\033[31m❌ Prisma migrations failed after $maxAttempts attempts\033[0m"
    echo -e "\033[33m📋 App container logs:\033[0m"
    docker compose logs ocpp-server | tail -50
    exit 1
fi

# Clean up temp file
rm -f /tmp/migration.log

# Final status check
echo ""
echo -e "\033[32m✅ OCPP Gateway is up and running!\033[0m"

# Access info
if [ "$traefikStatus" = "running" ]; then
    echo -e "\033[36m🌐 Access your application at: https://evms.folti.io\033[0m"
    echo -e "\033[36m📊 Traefik Dashboard: http://localhost:8080\033[0m"
else
    echo -e "\033[36m🌐 Direct access (no HTTPS): http://localhost:3000\033[0m"
    echo -e "\033[33m⚠️  Traefik is not running - HTTPS not available\033[0m"
fi

# Final container status
echo ""
echo -e "\033[36m📊 Final Container Status:\033[0m"
docker compose ps
echo ""
echo -e "\033[37m📋 Useful Commands:\033[0m"
echo -e "\033[37m   🔍 View all logs: docker compose logs -f\033[0m"
echo -e "\033[37m   🔍 View app logs: docker compose logs -f ocpp-server\033[0m"
echo -e "\033[37m   🔍 View Traefik logs: docker compose logs -f traefik\033[0m"
echo -e "\033[37m   🛑 Stop services: docker compose down\033[0m"
echo -e "\033[37m   🔄 Restart app: docker compose restart ocpp-server\033[0m"
echo -e "\033[37m   🔄 Restart Traefik: docker compose restart traefik\033[0m"
echo ""