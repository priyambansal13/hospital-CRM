# AI provider outage (Vertex AI)

**Signs:**
- The assistant replies "please talk to the front desk";
- copilot summaries and scribe drafts fail;
- ai-assistant-service logs show Vertex errors (quota, 5xx, region).

## What still works

- Emergency rules run **before** the model, so emergency words still get the emergency numbers.
- "Talk to a person" hands over to the front desk.
- Nothing clinical depends on the model: doctors write notes and prescriptions as usual.

## Do

1. **Vertex AI status** for `asia-south1`, and the project's quota page (requests per minute for the model).
2. **Quota:** ask for more, or lower use. Batch jobs such as care-gap wording can wait.
3. **A model withdrawn or renamed:** change the model setting and release. Run the eval suite before switching (docs/AI-AGENTS.md §9).
4. **Never** switch patient traffic to an AI Studio key. Production data stays on Vertex AI under the Cloud agreement.
5. **Status page:** component assistant, impact Minor.
