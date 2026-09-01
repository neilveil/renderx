# Base must match the playwright version pinned in package.json, otherwise
# `playwright install` below downloads a second copy of Chromium into the image
FROM mcr.microsoft.com/playwright:v1.57.0-noble

WORKDIR /app

# Create non-root user for security
RUN groupadd -r appuser && useradd -r -g appuser appuser

# Copy package files
COPY package.json package-lock.json* ./
COPY tsconfig.json ./

# Install all dependencies (including dev dependencies for TypeScript)
# Skip Playwright postinstall since Chromium is already in the base image
RUN npm ci --ignore-scripts

# No-op while the base image matches the pinned playwright version; kept so a version
# bump that outpaces the base still produces a working image rather than a broken one
RUN npx playwright install chromium

# Copy source code
COPY src/ ./src/

# Build TypeScript
RUN npm run build

# Create hosts directory (app will create it if missing, but better to have it)
RUN mkdir -p ./hosts

# Ship the demo app so the image is explorable on a bare `docker run`. config.json is
# deliberately NOT baked: a failed config mount must fail loudly rather than quietly
# serving a demo config in production.
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
  CMD node -e "const port = process.env.PORT || '8080'; require('http').get('http://localhost:' + port + '/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Start server
CMD ["node", "dist/index.js"]
