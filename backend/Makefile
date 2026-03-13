.PHONY: help build up down restart logs shell test clean install run

# Variables
COMPOSE_FILE := docker-compose.yml
SERVICE_NAME := app
IMAGE_NAME := elastic-app
CONTAINER_NAME := elastic-app

help: ## Show this help message
	@echo 'Usage: make [target]'
	@echo ''
	@echo 'Available targets:'
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z_-]+:.*?## / {printf "  %-15s %s\n", $$1, $$2}' $(MAKEFILE_LIST)



down: ## Stop and remove containers with volumes
	docker compose -f $(COMPOSE_FILE) down -v

restart: ## Restart the container
	$(MAKE) down
	$(MAKE) up

logs: ## View container logs
	docker compose -f $(COMPOSE_FILE) logs -f $(SERVICE_NAME)

logs-tail: ## View last 100 lines of logs
	docker compose -f $(COMPOSE_FILE) logs --tail=100 $(SERVICE_NAME)

MODULE ?= app.main
run: ## Run a Python module (usage: make run MODULE=app.data_processing.data_dictionary_processor)
	docker compose -f $(COMPOSE_FILE) run --rm $(SERVICE_NAME) python -m $(MODULE)

CMD ?= bash
exec: ## Run a command in the container (usage: make exec CMD="ls -la" or make exec CMD="python -c 'print(1)'")
	docker compose -f $(COMPOSE_FILE) run --rm $(SERVICE_NAME) $(CMD)

shell: ## Open an interactive shell in the container
	docker compose -f $(COMPOSE_FILE) run --rm $(SERVICE_NAME) bash

ps: ## Show running containers
	docker ps

up: ## Start services with volume mounts for hot reload
	docker compose -f $(COMPOSE_FILE) up

build: ## Build the container
	docker compose -f $(COMPOSE_FILE) build
