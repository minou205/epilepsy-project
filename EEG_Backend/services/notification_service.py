import httpx
from config import EXPO_PUSH_URL


async def send_push_to_tokens(tokens: list[str], title: str, body: str) -> int:
    if not tokens:
        return 0

    messages = [
        {
            "to"    : token,
            "title" : title,
            "body"  : body,
            "sound" : "default",
            "priority": "high",
        }
        for token in tokens
    ]

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            EXPO_PUSH_URL,
            json=messages,
            headers={
                "Accept"      : "application/json",
                "Content-Type": "application/json",
            },
        )
        resp.raise_for_status()

    return len(tokens)


def build_prediction_message(patient_id: str, patient_name: str) -> tuple[str, str]:
    title = "⚠ Seizure Warning"
    body  = (
        f"WARNING: A seizure occur in approximately 15 minutes for "
        f"patient number {patient_id}, named {patient_name}. "
        f"Intervention is requested if possible."
    )
    return title, body


def build_detection_message(patient_id: str, patient_name: str) -> tuple[str, str]:
    title = "🚨 Seizure Detected"
    body  = (
        f"WARNING: Patient number {patient_id}, named {patient_name}, "
        f"is currently having a seizure. Please intervene if possible."
    )
    return title, body
