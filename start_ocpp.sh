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
containers=$(docker compose ps --format "table {{.Service}}\t{{.State}}")
echo "$containers"

# Wait for database to be ready and run migrations
echo -e "\033[36m📦 Waiting for database and running Prisma migrations...\033[0m"

# First, wait for database to be ready
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

# Run Prisma migrations with retries
maxAttempts=5
attempt=1

while [ $attempt -le $maxAttempts ]; do
    echo -e "\033[37m   Migration attempt $attempt/$maxAttempts...\033[0m"
    
    if docker compose exec -T ocpp-server npx prisma migrate deploy > /dev/null 2>&1; then
        echo -e "\033[32m✅ Prisma migrations completed successfully!\033[0m"
        break
    else
        echo -e "\033[33m⚠️  Migration attempt $attempt failed, retrying...\033[0m"
        echo -e "\033[31mError output:\033[0m"
        docker compose exec -T ocpp-server npx prisma migrate deploy
        sleep 5
        ((attempt++))
    fi
done

if [ $attempt -gt $maxAttempts ]; then
    echo -e "\033[31m❌ Prisma migrations failed after $maxAttempts attempts\033[0m"
    echo -e "\033[33m📋 App container logs:\033[0m"
    docker compose logs ocpp-server
    exit 1
fi

# Final status check
echo ""
echo -e "\033[32m✅ OCPP Gateway is up and running!\033[0m"
echo -e "\033[36m🌐 Access your application at: http://localhost:3000\033[0m"
echo ""
echo -e "\033[36m📊 Final Container Status:\033[0m"
docker compose ps
echo ""
echo -e "\033[37m📋 Useful Commands:\033[0m"
echo -e "\033[37m   🔍 View all logs: docker compose logs -f\033[0m"
echo -e "\033[37m   🔍 View app logs: docker compose logs -f ocpp-server\033[0m"
echo -e "\033[37m   🛑 Stop services: docker compose down\033[0m"
echo -e "\033[37m   🔄 Restart app: docker compose restart ocpp-server\033[0m"