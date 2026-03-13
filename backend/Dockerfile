FROM python:3.11-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install Poetry
RUN pip install poetry

# Configure Poetry to not create virtual environment (use system Python)
RUN poetry config virtualenvs.create false

# Copy dependency files
COPY pyproject.toml poetry.lock ./

# Regenerate lock file if pyproject.toml changed, then install
RUN poetry lock && poetry install --no-interaction --no-ansi --no-root

# Copy application code into /app/backend/ so `import backend.X` works
COPY . ./backend/

# Set Python path to include app directory
ENV PYTHONPATH=/app

# Default command - keep container running
CMD ["tail", "-f", "/dev/null"]
