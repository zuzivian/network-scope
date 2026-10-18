// Turn an email address into an organisation label ("jo@mckinsey.com" -> "Mckinsey",
// "sam@gsb.stanford.edu" -> "Stanford"), so phone contacts cluster by where people work or
// study. Only that label is kept; the address itself is never stored. Webmail gives nothing.

const WEBMAIL = /^(gmail|googlemail|yahoo|ymail|rocketmail|hotmail|outlook|live|msn|icloud|me|mac|aol|proton|protonmail|pm|gmx|mail|email|inbox|qq|163|126|sina|yandex|zoho|hey|fastmail|tutanota|hushmail|comcast|verizon|att|sbcglobal|bellsouth|cox|charter|earthlink|optonline|btinternet|sky|virginmedia|orange|wanadoo|free|laposte|web|t-online|libero|naver|daum|hanmail|rediffmail|singnet|pacific|starhub|bigpond|optusnet|shaw|rogers|telus|example)$/;
// Second-level labels that sit under a country code ("company.com.sg", "uni.ac.uk").
const SLD = new Set(['com', 'co', 'net', 'org', 'edu', 'ac', 'gov', 'gob', 'or', 'ne', 'go', 'mil', 'nhs', 'sch']);

export function orgFromEmail(address: string): string | undefined {
  const m = /@([a-z0-9.-]+\.[a-z]{2,})\s*$/i.exec(address.trim());
  if (!m) return undefined;
  const parts = m[1].toLowerCase().split('.');
  const cc = parts.length >= 3 && parts[parts.length - 1].length === 2 && SLD.has(parts[parts.length - 2]);
  const label = parts[parts.length - (cc ? 3 : 2)];
  if (!label || WEBMAIL.test(label) || /^\d+$/.test(label)) return undefined;
  // Very short or vowel-less labels are initialisms (BCG, IBM, MSFT); others read as names (Bain, Meta).
  const initialism = label.length <= 3 || (label.length === 4 && !/[aeiouy]/.test(label));
  return initialism ? label.toUpperCase() : label[0].toUpperCase() + label.slice(1);
}
