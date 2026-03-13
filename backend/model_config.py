from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter(prefix="/api/model", tags=["model"])

# Default to Amazon Nova Pro (Claude models marked Legacy on this account)
class ModelState:
    active_model_id = "us.amazon.nova-pro-v1:0"

class ModelUpdateRequest(BaseModel):
    model_id: str

@router.get("")
def get_active_model():
    return {"model_id": ModelState.active_model_id}

@router.post("")
def set_active_model(req: ModelUpdateRequest):
    ModelState.active_model_id = req.model_id
    return {"model_id": ModelState.active_model_id}
