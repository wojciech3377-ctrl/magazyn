export const KSEF_STATUS: Record<string, { text: string; tone: "slate" | "amber" | "green" | "red" | "blue" }> = {
  issued: { text: "nie wysłana do KSeF", tone: "amber" },
  sending: { text: "w KSeF – przetwarzanie", tone: "blue" },
  accepted: { text: "przyjęta w KSeF", tone: "green" },
  rejected: { text: "odrzucona przez KSeF", tone: "red" },
  cancelled: { text: "unieważniona", tone: "slate" },
};
