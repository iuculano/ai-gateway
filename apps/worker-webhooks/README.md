# gateway-api

Simple gateway for interacting with various LLMs.

## Running locally

```bash
# Build a local image
docker build -t gateway-api:latest .

# Run all containers
docker compose -f docker-compose.yml -f docker-compose-gateway-api.yml up
```
