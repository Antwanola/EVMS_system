# -------------------
# Build stage
# -------------------
FROM node:20-alpine AS builder

# Set working directory
WORKDIR /usr/src/app

# Install dependencies needed to build native modules
RUN apk add --no-cache bash python3 g++ make

# Copy package files
COPY package*.json tsconfig.json ./

# Install all dependencies
RUN npm ci

# Copy Prisma schema
COPY prisma ./prisma/

# Generate Prisma client
RUN npx prisma generate

# Copy the rest of the source code
COPY . .

# Build TypeScript code
RUN npm run build

# -------------------
# Runtime stage
# -------------------
FROM node:20-alpine AS runner

WORKDIR /usr/src/app

# Install OpenSSL (required by Prisma)
RUN apk add --no-cache openssl

# Copy package files and production dependencies
COPY --from=builder /usr/src/app/package*.json ./
COPY --from=builder /usr/src/app/node_modules ./node_modules

# Copy built application and Prisma client
COPY --from=builder /usr/src/app/dist ./dist
COPY --from=builder /usr/src/app/prisma ./prisma
COPY --from=builder /usr/src/app/node_modules/.prisma ./node_modules/.prisma

# Create non-root user for security
RUN addgroup -S appuser && adduser -S appuser -G appuser
RUN chown -R appuser:appuser /usr/src/app
USER appuser

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/health', (res) => { process.exit(res.statusCode === 200 ? 0 : 1) })"

# Run migrations and start server
CMD ["sh", "-c", "npx prisma migrate deploy && npm run start:prod"]
