from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_data_dir: Path = Path("storage")
    backend_host: str = "127.0.0.1"
    backend_port: int = 8765
    log_level: str = "INFO"
    speech_model: str = "base"
    ollama_model: str = "qwen3:4b"
    ollama_vision_model: str = "qwen3-vl:4b"
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    @property
    def database_url(self) -> str:
        self.app_data_dir.mkdir(parents=True, exist_ok=True)
        return f"sqlite+aiosqlite:///{(self.app_data_dir / 'assistant.db').resolve().as_posix()}"

    @property
    def speech_model_dir(self) -> Path:
        path = self.app_data_dir / "models" / "speech"
        path.mkdir(parents=True, exist_ok=True)
        return path


settings = Settings()
