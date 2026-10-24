# Darija Receptionist

AI phone + WhatsApp receptionist for Tunisian dental cabinets. Speaks Tunisian Darija with French code-switching. Three intents: book, reschedule/cancel, FAQ. Everything else goes to a human.

```
eval/   STT engine evaluation (week-1 decision: which engine hears Darija on phone audio)
api/    NestJS backend: booking tools, Vapi webhook, emergency rule, call logs
```

## 1. Week-1: pick the speech engine

```bash
cd eval
pip install jiwer requests                       # + azure-cognitiveservices-speech, transformers torch for those engines
python3 -m unittest test_stt_eval                # offline: normalisation + engine adapters on stubbed HTTP, no keys
python3 stt_eval.py --data ./sample_calls --engines dryrun          # pipeline sanity check, no keys
DEEPGRAM_API_KEY=... AZURE_SPEECH_KEY=... AZURE_SPEECH_REGION=westeurope ELEVENLABS_API_KEY=... \
OPENAI_API_KEY=... GEMINI_API_KEY=... \
python3 stt_eval.py --data ./calls --engines deepgram,azure,elevenlabs,openai,gemini,hf --out results.json
```

Put real cabinet recordings in `calls/` as `call_NNN.wav` + `call_NNN.txt` (reference transcript, Darija in Arabic script, French in Latin). Decision rule printed with the table: **<20% WER → use it; >25% → fine-tune Whisper**. Set `HF_MODEL` to a Tunisian fine-tune from Hugging Face to test one.

`openai` (gpt-4o-transcribe) and `gemini` (gemini-2.5-flash, audio sent inline) are the LLM providers' batch transcription, there to answer "do we need a fine-tune at all?"; `OPENAI_STT_MODEL` / `GEMINI_STT_MODEL` override the model. A win for them in the table is the ceiling that provider reaches on our audio, not yet a live transcriber: the call pipeline needs streaming, so check what Vapi can run as a transcriber before choosing one.

## 2. Run the API

```bash
cd api
npm install
cp .env.example .env
npm test                 # 196 tests: slot engine, double-booking race, shift_day, emergency patterns, Google adapter races, admin commands, WhatsApp notifier, Gemini chat agent, module boot
npm run dev              # loads ./.env (Node ≥ 20.6), transpile-only (npm run lint type-checks), http://localhost:3000/health
```

Cabinet config lives in `api/cabinets/<id>.json` — this is what the 30-minute install conversation with the secretary produces. `demo.json` is a complete example.

### Smoke-test the webhook without Vapi

```bash
# What Vapi receives for an inbound call: prompt + tools + voice config
curl -s -X POST localhost:3000/webhooks/vapi -H 'content-type: application/json' \
  -d '{"message":{"type":"assistant-request","call":{"id":"c1","phoneNumber":{"number":"+21670000000"},"customer":{"number":"+21620123456"}}}}'

# A tool call from the model
curl -s -X POST localhost:3000/webhooks/vapi -H 'content-type: application/json' \
  -d '{"message":{"type":"tool-calls","call":{"id":"c1","phoneNumber":{"number":"+21670000000"},"customer":{"number":"+21620123456"}},"toolCallList":[{"id":"t1","function":{"name":"get_availability","arguments":{"type_id":"cleaning"}}}]}}'
```

### Wire Vapi

1. Vapi → Phone Numbers → import the SIP trunk number (or a Vapi number for the demo).
2. Vapi → Assistants: none needed; set **Server URL** = `https://<your host>/webhooks/vapi` on the phone number with the secret from `.env`. Vapi sends `assistant-request` and we answer with the full config per cabinet.
3. Cabinet forwards busy / no-answer / after-hours to that number.

### Wire Google Calendar

The agent writes into the calendar the secretary already uses; nothing is cached, every read is live.

1. Google Cloud → create a service account, enable the **Google Calendar API**, download its JSON key and set
   `GOOGLE_SERVICE_ACCOUNT_JSON=./google-sa.json` (the path, or the JSON itself) in `.env`. The key is gitignored.
2. Google Calendar → the cabinet's calendar → *Settings and sharing* → share it with the service-account email
   with **Make changes to events**, and copy the *Calendar ID* (`…@group.calendar.google.com`).
3. In `cabinets/<id>.json`: `"calendar": { "provider": "google", "calendar_id": "<that id>" }`, restart.

What the secretary sees: the agent's bookings as `Nom – Type` with the phone in the description, a `? ` prefix while
unconfirmed, a cancelled booking as a deleted event. Everything she types herself (a patient, "Vacances" all day)
counts as busy; events marked *Free* do not. Cabinets on `"provider": "memory"` keep working in the same process.

### Wire the WhatsApp admin webhook

1. Meta for Developers → your app → WhatsApp → *Configuration* → Callback URL `https://<your host>/webhooks/whatsapp`,
   Verify token = `WA_VERIFY_TOKEN` from `.env`, then subscribe to the `messages` field.
2. Set `WA_APP_SECRET` (App settings → Basic) so every POST is checked against `X-Hub-Signature-256`.
3. Only numbers in the cabinet's `whatsapp_admin` can give orders. The first word decides, in French, Darija
   (Arabic script or Tunizi) or English; no LLM is involved, so the same text always does the same thing.
   Anything else answers with the command list. Replies go through the `Notifier`.
4. Sending. Set `WA_PHONE_NUMBER_ID` and `WA_ACCESS_TOKEN` (WhatsApp → *API Setup*: the phone number ID and a
   permanent system-user token) and the app binds `MetaWhatsAppNotifier` at boot instead of `ConsoleNotifier`,
   which only logs — the same opt-in shape as `VAPI_SECRET`. Booking confirmations, reschedule notices, emergency
   alerts and the admin replies then go out on that number (Graph API v21.0, numbers without the `+`). The log
   carries Meta's message id or error code, never the token or the text.
5. Booking confirmation. Inside Meta's 24 h customer-service window (the patient wrote to the number) it is an
   interactive message with two reply buttons, **Confirmer** / **Annuler**. A patient who only *called* has no
   open window, so register a utility template — body `{{1}}`, two quick-reply buttons Confirmer and Annuler —
   get it approved and set `WA_TEMPLATE_BOOKING=<its name>` (`WA_TEMPLATE_LANG`, default `ar`). It is used when
   no inbound message from that number is known in the last 24 h, or when Meta refuses the interactive send with
   error 131047. Either tap comes back on this webhook as `confirm:<id>` / `cancel:<id>`, routed to the cabinet
   whose `whatsapp_patient_from` received it: the booking becomes `confirmed` (the `? ` prefix drops in Google
   Calendar) or cancelled, and the patient gets a one-line Darija answer.
6. Staff messages. The emergency alert to the doctor and a patient's message for the secretary reach a number that
   may not have written to the cabinet's WhatsApp in 24 h either: register a second utility template, body `{{1}}`,
   and set `WA_TEMPLATE_STAFF=<its name>`. Same rule as above, the `🚨 URGENT` prefix travels inside the parameter.
   Admin replies answer a message the admin just sent, so they stay free-form.

| The secretary texts | What happens |
| --- | --- |
| `STOP` (`arrêt`, `وقف`, `7bes`…) / `START` (`reprends`, `شغل`…) | `mode: off`, persisted: no booking, every call transferred to the secretariat / back to the mode it had before |
| `MODE on` · `MODE apprentissage` · `MODE off` | set_mode |
| `RDV`, `RDV demain`, `RDV vendredi`, `RDV 31/10` (or just `demain`) | list_day: time, name, type, phone |
| `RETARD 30`, `RETARD 1h30`, `AVANCE 15` | shift_day: moves today's remaining bookings and tells each patient the new time on WhatsApp |
| `BLOQUE vendredi`, `BLOQUE demain matin`, `BLOQUE 31/10 14h-16h congrès` | block_slots: a day, a half day or a range, with the reason; lists the bookings to move |
| `NOTE 20123456 patient anxieux` | add_patient_note: a memo per patient in `patient-notes/<cabinet>.json`, read into Amira's prompt when that number calls, never spoken |

```bash
# Meta's verification handshake
curl -s 'localhost:3000/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=change-me-too&hub.challenge=42'

# The doctor texts STOP (without WA_APP_SECRET the signature is not required)
curl -s -X POST localhost:3000/webhooks/whatsapp -H 'content-type: application/json' \
  -d '{"object":"whatsapp_business_account","entry":[{"changes":[{"value":{"messages":[{"id":"wamid.1","from":"21620000001","type":"text","text":{"body":"STOP"}}]}}]}]}'

# A patient taps Confirmer under the booking message (template quick reply; the interactive reply is `interactive.button_reply.id`)
curl -s -X POST localhost:3000/webhooks/whatsapp -H 'content-type: application/json' \n  -d '{"object":"whatsapp_business_account","entry":[{"changes":[{"value":{"metadata":{"display_phone_number":"21670000000"},"messages":[{"id":"wamid.2","from":"21655555555","type":"button","button":{"text":"Confirmer","payload":"confirm:<booking id>"}}]}}]}]}'
```

### Amira on WhatsApp (patient chat)

With `GEMINI_API_KEY` set, a patient's text or voice note to the cabinet's number is answered in the same chat by
Gemini (`gemini-2.5-flash`; `GEMINI_CHAT_MODEL` overrides), with the same system prompt and booking tools as the
phone agent plus a written-channel style block (`CHAT_TOOLS` in `src/agent/tools.ts` is everything but `transfer`).
A voice note is downloaded from Meta (needs `WA_ACCESS_TOKEN`) and transcribed first, so the emergency regexes and
the call log see text. The emergency rule runs before the model on every message and alerts the doctor; `mode: off`
(STOP) answers a fixed line with the cabinet phone and skips the model; a model or network failure becomes a short
apology with the phone number, never silence. One conversation per (cabinet, patient) is kept in memory for two
hours; every turn lands in `call-logs/` under `wa:<phone>`. Without a key, patient messages are logged and left
alone while button taps and admin commands keep working. The cabinet is the one whose number received the message
(`metadata.display_phone_number` = `whatsapp_patient_from`), so a local smoke test must include that field:

```bash
curl -s -X POST localhost:3000/webhooks/whatsapp -H 'content-type: application/json' \
  -d '{"object":"whatsapp_business_account","entry":[{"changes":[{"value":{"metadata":{"display_phone_number":"21670000000"},"messages":[{"id":"wamid.2","from":"21655555555","type":"text","text":{"body":"نحب rdv تنظيف"}}]}}]}]}'
```

Voice *calls* over WhatsApp are a later step: Meta's Calling API hands the business a WebRTC session, which needs a
bridge into the Vapi pipeline or a provider that does it.

## How it is built

| Piece | File | Rule it enforces |
| --- | --- | --- |
| Calendar port | `src/calendar/calendar.port.ts` | One calendar, live read/write, atomic `book`/`move` that re-check at write time |
| Slot engine | `src/booking/slots.ts` | Opening hours, lunch, `last_booking`, per-type duration, 15-min step; pure function |
| Booking tools | `src/booking/booking.service.ts` | `get_availability`, `book`, `find_my_bookings`, `reschedule`, `cancel`; admin `list_day`, `block_slots`, `shift_day` |
| Emergency | `src/agent/emergency.ts` | Regex over Arabic / Tunizi / French, runs on every user turn before the LLM; alerts the doctor |
| Prompt + tools | `src/agent/tools.ts` | Darija-first prompt, confirm-before-book, no medical advice, learning mode |
| Webhook | `src/agent/vapi.controller.ts` | Routes by called number, dispatches tools, sends WhatsApp confirmation |
| Call log | `src/agent/call-log.service.ts` | JSONL per day on our disk, 90-day purge; doubles as the regression corpus |
| Google adapter | `src/calendar/google.calendar.ts` | One Google calendar per cabinet; bookings tagged in private properties; write-then-verify so a race leaves one event and a human's event always wins |
| Calendar routing | `src/calendar/calendar.router.ts` | Each cabinet's `calendar.provider` picks `memory` or `google`; the Google client is only built when a cabinet needs it |
| WhatsApp sending | `src/notify/meta-whatsapp.notifier.ts` | Graph API over `fetch`, bound when `WA_PHONE_NUMBER_ID` + `WA_ACCESS_TOKEN` exist; reply buttons inside the 24 h window, approved template outside it or on error 131047; a failed send is logged (id / error code, never the token), never thrown into a call |
| Admin by chat | `src/admin/whatsapp.controller.ts`, `admin-chat.service.ts`, `commands.ts`, `when.ts`, `patient-notes.service.ts` | Meta handshake, signature over the raw body, retry dedupe; `whatsapp_admin` numbers only; a deterministic FR / Darija / EN keyword grammar for STOP, START, MODE, RDV, RETARD, BLOQUE, NOTE; STOP persists `mode: off`; patient memos stay on our disk and reach the prompt, never the patient |
| Amira on WhatsApp | `src/agent/whatsapp-chat.service.ts`, `gemini.client.ts`, `agent-tools.service.ts`, `whatsapp-media.ts` | Gemini with function calling over the same prompt and tools as the phone (one dispatcher for both channels); voice notes transcribed first; emergency rule before the model; mode off and failures answer with the cabinet phone; two-hour in-memory conversation; every turn in the call log |

## Next

- [x] `GoogleCalendar` implementing `CalendarPort` (`googleapis` already in deps)
- [x] `MetaWhatsAppNotifier` implementing `Notifier` (interactive confirmer/annuler buttons in the 24 h window, approved template outside it; taps land on the webhook)
- [ ] 24h reminder job + morning call on unconfirmed
- [x] Admin-by-chat webhook (`/webhooks/whatsapp`): STOP/START keyword (handshake, signature, retry dedupe, admin numbers only)
- [x] Admin commands on that webhook: `MODE` (set_mode), `RETARD`/`AVANCE` (shift_day, patients told on WhatsApp), `BLOQUE` (block_slots), `RDV` (list_day), `NOTE` (add_patient_note, read into the prompt when that patient calls)
- [x] Amira on WhatsApp: patient texts and voice notes answered in the chat by Gemini with the booking tools
- [ ] WhatsApp voice calls (Meta Calling API is WebRTC: a bridge into the Vapi pipeline, or a provider such as Voximplant)
- [ ] Weekly summary message per cabinet (bookings the cabinet would have missed)
- [ ] Replay `call-logs/*.jsonl` as a regression test; block release if emergency detection drops
"# Agent_booking" 
