#!/bin/bash

set -e  # Exit immediately if a command fails

echo "🚀 Deploying OCPP Gateway to production..."

# Step 1: Pull latest code
echo "📥 Pulling latest changes from main branch..."
git pull origin main

# Step 2: Stop current containers
echo "🛑 Stopping old containers..."
docker-compose down

# Step 3: Build and start containers
echo "🔨 Building and starting containers..."
docker-compose up --build -d

# Step 4: Wait for DB to be ready
echo "⏳ Waiting for database to be ready..."
sleep 5

# Step 5: Run migrations
echo "📦 Running Prisma migrations..."
docker exec -it ocpp_gateway npx prisma migrate deploy

# Step 6: Cleanup unused images
echo "🧹 Cleaning up unused Docker images..."
docker image prune -f

echo "✅ Deployment completed! App is live."
