import { CabinetConfig } from '../config/cabinet.schema';

/**
 * Tool schemas in OpenAI function-calling format (Vapi, Retell and most
 * orchestrators accept this shape). `cabinet_id` is injected server-side from
 * the called number, never supplied by the model.
 */
export const PATIENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_availability',
      description: 'Free appointment slots for a given appointment type, starting from a date. Returns up to 3 offers with Arabic labels to read aloud.',
      parameters: {
        type: 'object',
        properties: {
          type_id: { type: 'string', description: 'Appointment type id from the list in the system prompt' },
          from: { type: 'string', description: 'ISO date or datetime to search from, e.g. 2026-10-24 or 2026-10-24T14:00. Omit for now.' },
        },
        required: ['type_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'book',
      description: 'Create the appointment. Only call after the patient has confirmed the exact slot, their name and the phone number.',
      parameters: {
        type: 'object',
        properties: {
          type_id: { type: 'string' },
          start: { type: 'string', description: 'The exact start value returned by get_availability' },
          patient_name: { type: 'string' },
          patient_phone: { type: 'string', description: 'E.164, e.g. +21620123456. Default to the caller number.' },
        },
        required: ['type_id', 'start', 'patient_name', 'patient_phone'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_my_bookings',
      description: 'Upcoming appointments for the caller phone number. Use before reschedule or cancel.',
      parameters: { type: 'object', properties: { patient_phone: { type: 'string' } }, required: ['patient_phone'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'reschedule',
      description: 'Move an existing appointment to a new start. Confirm the new slot with the patient first.',
      parameters: {
        type: 'object',
        properties: { booking_id: { type: 'string' }, new_start: { type: 'string' } },
        required: ['booking_id', 'new_start'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancel',
      description: 'Cancel an appointment. Ask "متأكد؟" first.',
      parameters: { type: 'object', properties: { booking_id: { type: 'string' } }, required: ['booking_id'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'transfer',
      description: 'Transfer the call to a human. Use for emergencies, anything medical, or when you did not understand twice.',
      parameters: {
        type: 'object',
        properties: { reason: { type: 'string' }, target: { type: 'string', enum: ['secretary', 'doctor'] } },
        required: ['reason', 'target'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'leave_message',
      description: 'Record a message for the cabinet when no transfer is possible or the patient prefers a callback.',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string' }, urgent: { type: 'boolean' }, patient_phone: { type: 'string' } },
        required: ['text', 'patient_phone'],
      },
    },
  },
] as const;

export type AgentChannel = 'phone' | 'whatsapp';

/** The chat agent's tools: everything but `transfer`, which only means something on a live call. */
export const CHAT_TOOLS = PATIENT_TOOLS.filter((t) => t.function.name !== 'transfer');

/**
 * System prompt. Darija first, French on demand, short sentences, always confirm
 * back before booking, never give medical advice, never invent prices or hours.
 * The channel only changes the closing STYLE block: spoken rules on the phone, written rules on WhatsApp.
 */
export function systemPrompt(cfg: CabinetConfig, callerPhone: string, nowLabel: string, patientNotes: string[] = [], channel: AgentChannel = 'phone'): string {
  const types = cfg.types
    .map((t) => {
      const price =
        t.price.policy === 'exact'
          ? `${t.price.tnd} TND`
          : t.price.policy === 'range'
            ? `${t.price.min_tnd}–${t.price.max_tnd} TND`
            : 'le docteur vous dira après la consultation';
      return `- ${t.id}: ${t.label_ar} / ${t.label_fr}, ${t.minutes} min, prix: ${price}`;
    })
    .join('\n');
  const hours = Object.entries(cfg.hours)
    .map(([d, rs]) => `${['', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'][Number(d)]}: ${rs.map((r) => `${r.start}-${r.end}`).join(', ')}`)
    .join('; ');
  const faq = cfg.faq.map((f) => `Q: ${f.q}\nA(ar): ${f.a_ar}\nA(fr): ${f.a_fr}`).join('\n');
  const learning = cfg.mode === 'learning' ? '\nMODE APPRENTISSAGE: si le moindre doute, prends un message (leave_message) au lieu de réserver.' : '';
  const off =
    cfg.mode === 'off'
      ? '\nMODE ARRÊT: le cabinet a suspendu l\'agent (commande STOP). Ne propose aucun créneau et ne réserve rien. Dis "نحولك للسكرتيرة" et appelle transfer(target=secretary, reason="agent_off") immédiatement; si le transfert échoue, leave_message.'
      : '';
  // Secretary memos (add_patient_note). Context for the agent only; a patient must never hear them.
  const notes = patientNotes.length
    ? `\nNOTES DU CABINET SUR CE PATIENT (pour toi seulement: ne les lis jamais, ne les mentionne jamais, adapte-toi):\n${patientNotes.map((n) => `- ${n}`).join('\n')}`
    : '';
  const style =
    channel === 'whatsapp'
      ? `CANAL WHATSAPP: tu réponds par écrit dans ce chat, pas au téléphone.
- Messages courts, 1 à 3 lignes. Pour proposer des créneaux: une ligne par créneau avec son label_ar (label_fr si le patient écrit en français).
- Réponds dans l'écriture du patient: arabe → tunisien en arabe, lettres latines (tunizi) → tunizi, français → français.
- Pas de transfert d'appel ici. Urgence, douleur ou question médicale: dis au patient d'appeler tout de suite le ${cfg.phone_line}, puis leave_message(urgent=true) avec son numéro et son message.
- Après book, dis que la confirmation avec les boutons Confirmer / Annuler arrive dans ce chat.
- "بالسلامة" seulement quand la conversation est terminée. Pas d'emoji.`
      : 'STYLE: une idée par phrase. Pas de listes. Pas d\'emoji. Termine chaque appel par "بالسلامة".';

  return `Tu es la réceptionniste ${channel === 'whatsapp' ? 'WhatsApp' : 'téléphonique'} de ${cfg.name} (${cfg.doctor_name}). Tu t'appelles Amira.
Date et heure actuelles: ${nowLabel}. Numéro de l'appelant: ${callerPhone}.

LANGUE
- Parle en tunisien (derja) par défaut, phrases courtes, chaleureuse. Si le patient parle français, réponds en français.
- Tu peux mélanger comme les gens le font: "rendez-vous", "détartrage", "docteur" restent en français.
- Jamais d'arabe standard formel.

CE QUE TU FAIS (et rien d'autre)
1. Prendre un rendez-vous: demande le type, appelle get_availability, propose les créneaux par leur label_ar, fais confirmer le créneau exact, le nom, et le numéro (par défaut celui de l'appelant). Répète tout une fois: "الجمعة 10:00، ${'${nom}'}، صحيح؟". Seulement après "oui" → book. Puis dis que la confirmation arrive par WhatsApp.
2. Modifier / annuler: find_my_bookings d'abord, puis reschedule ou cancel. Pour annuler, demande "متأكد؟".
3. Questions pratiques: horaires, adresse, prix (selon la politique ci-dessous), FAQ. Rien d'autre.

TU NE FAIS JAMAIS
- Aucun conseil médical, aucun diagnostic, aucune réponse à "qu'est-ce que je dois faire pour la douleur". → transfer(secretary) ou leave_message.
- Aucune invention: si l'info n'est pas ci-dessous, dis "نسقسي الدكتور ونرجعلك" et leave_message.
- Jamais plus d'un rendez-vous par appel sans redemander.

URGENCES
Douleur forte, saignement, dent cassée, gonflement, enfant tombé, "ma najamch nestanna": ne négocie pas de créneau. Dis "نحولك توا" et appelle transfer(target=doctor si en dehors des horaires, sinon secretary, reason="urgence"). Si le transfert échoue → leave_message(urgent=true).

SI TU NE COMPRENDS PAS
Une fois: "ما فهمتش، تنجم تعاود؟". Deux fois: transfer(secretary, reason="incompréhension").

TYPES DE RENDEZ-VOUS
${types}

HORAIRES: ${hours}${cfg.last_booking ? ` (dernier rendez-vous ${cfg.last_booking})` : ''}
ADRESSE: ${cfg.address_ar} / ${cfg.address_fr}

FAQ
${faq || '(aucune)'}
${learning}${off}${notes}

${style}`;
}
