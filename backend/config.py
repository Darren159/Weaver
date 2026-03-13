from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # Google OAuth
    google_client_id: str
    google_client_secret: str
    oauth_redirect_uri: str = "http://localhost:8000/auth/google/callback"

    # Secret used to sign session JWTs
    secret_key: str = "change-me-in-production"

    # Where tokens are persisted on disk (simple JSON store for development)
    token_store_path: str = "/app/data/tokens.json"

    # Elasticsearch — ES_NODE / ES_API_KEY
    es_node: str = ""
    es_api_key: str = ""

    # Kibana / Fleet — KIBANA_URL / KIBANA_API_KEY
    kibana_url: str = ""
    kibana_api_key: str = ""

    model_config = {"env_file": ".env", "extra": "ignore"}


settings = Settings()  # type: ignore[call-arg]

