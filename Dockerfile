# Use Playwright official image with Chromium
FROM mcr.microsoft.com/playwright:v1.40.0-focal

WORKDIR /app

# Create non-root user for security
RUN groupadd -r appuser && useradd -r -g appuser appuser

# Copy package files
COPY package.json package-lock.json* ./
COPY tsconfig.json ./

# Install all dependencies (including dev dependencies for TypeScript)
# Skip Playwright postinstall since Chromium is already in the base image
RUN npm ci --ignore-scripts

# Install Playwright Chromium (browsers are in base image, but Playwright needs to be configured)
# This must run as root before switching to appuser
RUN npx playwright install chromium

# Copy source code
COPY src/ ./src/

# Build TypeScript
RUN npm run build

# Create hosts directory (app will create it if missing, but better to have it)
RUN mkdir -p ./hosts

# Copy runtime files
# Note: config.json is optional (wildcard makes it optional) - app can work with env vars only
# hosts/ directory can be mounted as volume at runtime to override
COPY config.json* ./
COPY hosts/ ./hosts/

# Remove dev dependencies to reduce image size
RUN npm prune --production

# Change ownership to non-root user
RUN chown -R appuser:appuser /app

# Switch to non-root user
USER appuser

# Expose port (default 8080, can be overridden via PORT env var)
EXPOSE 8080

# Health check - uses PORT env var or defaults to 8080
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "const port = process.env.PORT || '8080'; require('http').get(`http://localhost:${port}/health`, (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Start server
CMD ["node", "dist/index.js"]

# docker build -t neilveil/renderx:latest .
# docker tag neilveil/renderx:latest neilveil/renderx:v1.0.0
# docker login
# docker push neilveil/renderx:latest
# docker push neilveil/renderx:v1.0.0
