PNPM ?= pnpm
TEST_DB_PORT ?= 55432
COMPOSE_TEST = docker compose -f docker-compose.test.yml

# Overrides any DB_URL in .env: process.loadEnvFile never replaces a variable already set.
export DB_URL = postgresql://postgres:postgres@127.0.0.1:$(TEST_DB_PORT)/relaybox_dev
export TEST_DB_PORT

.PHONY: test-db-up test-db-down test test-file

test-db-up:
	$(COMPOSE_TEST) up -d --wait

test-db-down:
	$(COMPOSE_TEST) down

# Full suite; CI runs this on push.
test: test-db-up
	$(PNPM) run test:run

# One or more files: make test-file FILE="tests/unit/config.test.ts tests/integration/webhook-api.test.ts"
test-file: test-db-up
	$(PNPM) run test:file $(FILE)
