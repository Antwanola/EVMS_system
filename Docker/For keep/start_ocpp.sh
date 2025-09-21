# start-ocpp.ps1
Write-Host "🚀 Starting OCPP Gateway..." -ForegroundColor Green

# Stop any running containers
Write-Host "🛑 Stopping existing containers..." -ForegroundColor Yellow
docker compose down --remove-orphans

# Build and start containers
Write-Host "🔨 Building and starting containers..." -ForegroundColor Cyan
docker compose up --build -d

# Wait for containers to start
Write-Host "⏳ Waiting for containers to start..." -ForegroundColor Yellow
Start-Sleep -Seconds 15

# Check if containers are running
Write-Host "🔍 Checking container status..." -ForegroundColor Cyan
$containers = docker compose ps --format "table {{.Service}}\t{{.State}}"
Write-Host $containers

# Wait for database to be ready and run migrations
Write-Host "📦 Waiting for database and running Prisma migrations..." -ForegroundColor Cyan

# First, wait for database to be ready
Write-Host "   Checking database connectivity..." -ForegroundColor Gray
$dbReady = $false
$dbAttempts = 0
$maxDbAttempts = 30

do {
    $dbAttempts++
    Write-Host "   Database check attempt $dbAttempts/$maxDbAttempts..." -ForegroundColor Gray

    $dbCheck = docker compose exec -T postgres pg_isready -U postgres -d ocpp 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host "✅ Database is ready!" -ForegroundColor Green
        $dbReady = $true
        break
    }

    Start-Sleep -Seconds 2
} while ($dbAttempts -lt $maxDbAttempts)

if (-not $dbReady) {
    Write-Host "❌ Database failed to become ready" -ForegroundColor Red
    docker compose logs postgres
    exit 1
}

# Run Prisma migrations with retries
$maxAttempts = 5
$attempt = 1

do {
    Write-Host "   Migration attempt $attempt/$maxAttempts..." -ForegroundColor Gray

    $migrationResult = docker compose exec -T ocpp-server npx prisma migrate deploy 2>&1
    $exitCode = $LASTEXITCODE

    if ($exitCode -eq 0) {
        Write-Host "✅ Prisma migrations completed successfully!" -ForegroundColor Green
        break
    } else {
        Write-Host "⚠️  Migration attempt $attempt failed, retrying..." -ForegroundColor Yellow
        Write-Host "Error output:" -ForegroundColor Red
        Write-Host $migrationResult
        Start-Sleep -Seconds 5
        $attempt++
    }
} while ($attempt -le $maxAttempts)

if ($attempt -gt $maxAttempts) {
    Write-Host "❌ Prisma migrations failed after $maxAttempts attempts" -ForegroundColor Red
    Write-Host "📋 App container logs:" -ForegroundColor Yellow
    docker compose logs ocpp-server
    exit 1
}

# Final status check
Write-Host ""
Write-Host "✅ OCPP Gateway is up and running!" -ForegroundColor Green
Write-Host "🌐 Access your application at: http://localhost:3000" -ForegroundColor Cyan
Write-Host ""
Write-Host "📊 Final Container Status:" -ForegroundColor Cyan
docker compose ps
Write-Host ""
Write-Host "📋 Useful Commands:" -ForegroundColor Gray
Write-Host "   🔍 View all logs: docker compose logs -f" -ForegroundColor Gray
Write-Host "   🔍 View app logs: docker compose logs -f ocpp-server" -ForegroundColor Gray
Write-Host "   🛑 Stop services: docker compose down" -ForegroundColor Gray
Write-Host "   🔄 Restart app: docker compose restart ocpp-server" -ForegroundColor Gray
