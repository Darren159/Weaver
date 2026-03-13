from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter(prefix="/api/model", tags=["model"])

# Default to Claude 3.5 Sonnet
class ModelState:
    active_model_id = "us.anthropic.claude-3-5-sonnet-20241022-v2:0"

class ModelUpdateRequest(BaseModel):
    model_id: str

@router.get("")
def get_active_model():
    return {"model_id": ModelState.active_model_id}

@router.post("")
def set_active_model(req: ModelUpdateRequest):
    ModelState.active_model_id = req.model_id
    return {"model_id": ModelState.active_model_id}
