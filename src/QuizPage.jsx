import { useState } from "react";

// ── OlivaFix Gold — "Kleefpasta-check" quiz ──────────────────────────────
// Brand tokens (matching bestaande webshop):
const COLORS = {
  forest: "#1B3D2F",
  gold: "#C9973E",
  cream: "#F5F1E3",
};

const QUESTIONS = [
  {
    id: "brand",
    text: "Welke kleefpasta gebruik je op dit moment?",
    options: [
      "Een bekend supermarktmerk",
      "Een apotheekmerk",
      "Wisselend, ik ben nog op zoek",
      "Nog geen vast merk",
    ],
  },
  {
    id: "reapply",
    text: "Hoe vaak moet je tijdens de dag bijsmeren?",
    options: ["Nooit", "1 keer", "2 tot 3 keer", "Meer dan 3 keer"],
  },
  {
    id: "taste",
    text: "Hinder de smaak of geur van je kleefpasta je weleens?",
    options: ["Ja, vaak", "Soms", "Zelden", "Nooit opgemerkt"],
  },
  {
    id: "moment",
    text: "Had je ooit een ongemakkelijk moment door je kleefpasta — tijdens eten, lachen of praten?",
    options: ["Ja, regelmatig", "Af en toe", "Zelden", "Nooit"],
  },
  {
    id: "priority",
    text: "Wat vind je het belangrijkst in een kleefpasta?",
    options: [
      "Houdt de hele dag",
      "Natuurlijke ingrediënten",
      "Neutrale smaak en geur",
      "Prijs",
    ],
  },
];

// Elke keuze op index 0-3 telt mee voor de "afhankelijkheids-score".
// Hogere index = meer hinder = sterker in het voordeel van overstappen.
function computeTier(answers) {
  const values = Object.values(answers);
  const score = values.reduce((sum, i) => sum + i, 0);
  const max = QUESTIONS.length * 3;
  const ratio = score / max;

  if (ratio >= 0.6) {
    return {
      label: "Hoog tijd voor een frisse start",
      copy:
        "Je merkt duidelijk hinder van je huidige kleefpasta — vaak bijsmeren, een vieze nasmaak, of net dat ene ongemakkelijke moment. OlivaFix Gold is gemaakt met olijfolie in plaats van synthetische chemicaliën: neutrale smaak, en houvast die de hele dag meegaat.",
    };
  }
  if (ratio >= 0.3) {
    return {
      label: "Ruimte voor verbetering",
      copy:
        "Je huidige kleefpasta doet zijn werk, maar niet zonder kleine ergernissen. Veel van onze klanten kwamen net om die reden over: minder bijsmeren, en geen chemische bijsmaak meer dankzij de olijfolie-basis van OlivaFix Gold.",
    };
  }
  return {
    label: "Je zit al best goed — maar dit kan nog beter",
    copy:
      "Je huidige kleefpasta stoort je weinig, knap. Toch kiezen steeds meer mensen bewust voor een natuurlijke basis in plaats van synthetische chemicaliën — ook als voorzorg voor de lange termijn. OlivaFix Gold geeft dezelfde houvast, met olijfolie in plaats van chemicaliën.",
  };
}

export default function QuizPage() {
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState({});
  const [email, setEmail] = useState("");
  const [consent, setConsent] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const total = QUESTIONS.length;
  const isDone = step >= total;
  const tier = isDone ? computeTier(answers) : null;

  function selectAnswer(optionIndex) {
    const q = QUESTIONS[step];
    setAnswers((prev) => ({ ...prev, [q.id]: optionIndex }));
    setStep((s) => s + 1);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    if (!email || !email.includes("@")) {
      setError("Vul een geldig e-mailadres in.");
      return;
    }
    if (!consent) {
      setError("Vink aan dat je marketingmails wil ontvangen om je resultaat + kortingscode te krijgen.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(
        "https://proactive-happiness-production.up.railway.app/api/quiz-lead",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email,
            answers,
            tier: tier.label,
            marketingConsent: consent,
          }),
        }
      );
      if (!res.ok) throw new Error("Serverfout");
      setSubmitted(true);
    } catch (err) {
      setError("Er ging iets mis. Probeer het straks opnieuw.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <div style={styles.eyebrow}>OlivaFix Gold — kleefpasta-check</div>

        {!isDone && (
          <>
            <div style={styles.progressTrack}>
              <div
                style={{
                  ...styles.progressFill,
                  width: `${(step / total) * 100}%`,
                }}
              />
            </div>
            <p style={styles.stepCount}>
              Vraag {step + 1} van {total}
            </p>

            <h1 style={styles.question}>{QUESTIONS[step].text}</h1>

            <div style={styles.options}>
              {QUESTIONS[step].options.map((opt, i) => (
                <button
                  key={opt}
                  onClick={() => selectAnswer(i)}
                  style={styles.optionButton}
                >
                  {opt}
                </button>
              ))}
            </div>
          </>
        )}

        {isDone && !submitted && (
          <div>
            <h1 style={styles.question}>Je resultaat is klaar</h1>

            <div style={styles.blurWrap}>
              <div style={styles.blurredResult}>
                <p style={styles.tierLabel}>{tier.label}</p>
                <p style={styles.tierCopy}>{tier.copy}</p>
              </div>
              <div style={styles.blurOverlay} />
            </div>

            <p style={styles.unlockText}>
              Vul je e-mailadres in om je volledige resultaat en een
              persoonlijke kortingscode te ontvangen.
            </p>

            <form onSubmit={handleSubmit} style={styles.form}>
              <input
                type="email"
                placeholder="jouw@email.be"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                style={styles.input}
              />

              <label style={styles.checkboxLabel}>
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(e) => setConsent(e.target.checked)}
                  style={styles.checkbox}
                />
                <span>
                  Ja, stuur me mijn resultaat en houd me op de hoogte van
                  OlivaFix-aanbiedingen per e-mail.
                </span>
              </label>

              {error && <p style={styles.errorText}>{error}</p>}

              <button
                type="submit"
                disabled={submitting}
                style={styles.submitButton}
              >
                {submitting ? "Bezig..." : "Toon mijn resultaat"}
              </button>
            </form>
          </div>
        )}

        {submitted && (
          <div>
            <h1 style={styles.question}>{tier.label}</h1>
            <p style={styles.tierCopy}>{tier.copy}</p>
            <p style={styles.confirmNote}>
              Check je inbox — je kortingscode is onderweg.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

const styles = {
  page: {
    minHeight: "100vh",
    background: COLORS.cream,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "24px",
    fontFamily: "'Fraunces', Georgia, serif",
  },
  card: {
    width: "100%",
    maxWidth: "520px",
    background: "#fff",
    borderRadius: "16px",
    padding: "32px 28px",
    boxShadow: "0 10px 40px rgba(27, 61, 47, 0.12)",
  },
  eyebrow: {
    fontSize: "13px",
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    color: COLORS.gold,
    fontWeight: 600,
    marginBottom: "18px",
  },
  progressTrack: {
    height: "6px",
    borderRadius: "999px",
    background: "#EDE7D6",
    overflow: "hidden",
    marginBottom: "8px",
  },
  progressFill: {
    height: "100%",
    background: COLORS.gold,
    transition: "width 0.3s ease",
  },
  stepCount: {
    fontSize: "13px",
    color: "#8A8577",
    marginBottom: "22px",
    fontFamily: "system-ui, sans-serif",
  },
  question: {
    fontSize: "24px",
    lineHeight: 1.3,
    color: COLORS.forest,
    marginBottom: "22px",
    fontWeight: 600,
  },
  options: {
    display: "flex",
    flexDirection: "column",
    gap: "10px",
  },
  optionButton: {
    textAlign: "left",
    padding: "14px 16px",
    borderRadius: "10px",
    border: "1.5px solid #E3DCC8",
    background: "#fff",
    fontSize: "16px",
    fontFamily: "system-ui, sans-serif",
    color: COLORS.forest,
    cursor: "pointer",
    minHeight: "48px",
  },
  blurWrap: {
    position: "relative",
    marginBottom: "20px",
  },
  blurredResult: {
    filter: "blur(6px)",
    userSelect: "none",
    padding: "18px",
    background: COLORS.cream,
    borderRadius: "10px",
  },
  blurOverlay: {
    position: "absolute",
    inset: 0,
    borderRadius: "10px",
  },
  tierLabel: {
    fontSize: "19px",
    fontWeight: 600,
    color: COLORS.forest,
    marginBottom: "8px",
  },
  tierCopy: {
    fontSize: "15px",
    lineHeight: 1.5,
    color: COLORS.forest,
    fontFamily: "system-ui, sans-serif",
  },
  unlockText: {
    fontSize: "15px",
    color: "#5C5748",
    marginBottom: "16px",
    fontFamily: "system-ui, sans-serif",
  },
  form: {
    display: "flex",
    flexDirection: "column",
    gap: "12px",
  },
  input: {
    padding: "14px 16px",
    borderRadius: "10px",
    border: "1.5px solid #E3DCC8",
    fontSize: "16px",
    fontFamily: "system-ui, sans-serif",
    minHeight: "48px",
  },
  checkboxLabel: {
    display: "flex",
    alignItems: "flex-start",
    gap: "10px",
    fontSize: "13px",
    color: "#5C5748",
    fontFamily: "system-ui, sans-serif",
    lineHeight: 1.4,
  },
  checkbox: {
    marginTop: "3px",
    minWidth: "18px",
    minHeight: "18px",
  },
  errorText: {
    color: "#B3432B",
    fontSize: "13px",
    fontFamily: "system-ui, sans-serif",
  },
  submitButton: {
    padding: "15px",
    borderRadius: "10px",
    border: "none",
    background: COLORS.forest,
    color: "#fff",
    fontSize: "16px",
    fontWeight: 600,
    fontFamily: "system-ui, sans-serif",
    cursor: "pointer",
    minHeight: "48px",
  },
  confirmNote: {
    marginTop: "12px",
    fontSize: "14px",
    color: "#5C5748",
    fontFamily: "system-ui, sans-serif",
  },
};
