import { describe, it, expect } from 'vitest';
import { csvToResult, importFile, type ImportResult } from './index';

// Synthetic fixtures: each contains contact details and message text that must never surface.
const FIXTURES: { name: string; text: string; secrets: string[] }[] = [
  {
    name: 'Connections.csv',
    text: 'Notes:\n"x"\n\nFirst Name,Last Name,URL,Email Address,Company,Position,Connected On\nAda,Quill,https://l/in/ada,ada.quill@example.com,Acme,Eng,01 Oct 2026\n',
    secrets: ['ada.quill@example.com'],
  },
  {
    name: 'contacts.vcf',
    text: 'BEGIN:VCARD\nFN:Ben Okoro\nTEL:+65 9123 4567\nEMAIL:ben@example.org\nADR:;;1 Fake St;;;;\nBDAY:1990-02-03\nNOTE:private note text\nEND:VCARD',
    secrets: ['ben@example.org', '9123 4567', '1 Fake St', '1990-02-03', 'private note text'],
  },
  {
    name: 'google.csv',
    text: 'First Name,Last Name,Labels,E-mail 1 - Value,Phone 1 - Value,Birthday\nCy,Dunn,* myContacts ::: Work,cy@example.net,+1 650 555 0100,1985-05-05\n',
    secrets: ['cy@example.net', '650 555 0100', '1985-05-05'],
  },
  {
    name: 'WhatsApp Chat - Squad 12.txt',
    text: [
      '[13/10/2026, 21:04:11] Dee Ford: the launch code is swordfish',
      '[13/10/2026, 21:05:11] Eli Gray: meet me at the old bridge',
      '[13/10/2026, 21:06:11] +44 7700 900123: who am I',
      '[13/10/2026, 21:07:11] Fay Hall: call me on 07700900456',
    ].join('\n'),
    secrets: ['swordfish', 'old bridge', 'who am I', '7700', 'call me'],
  },
  {
    name: 'your_friends.json',
    text: JSON.stringify({ friends_v2: [{ name: 'Gus Ives', timestamp: 1600000000 }] }),
    secrets: [],
  },
  {
    name: 'followers_1.json',
    text: JSON.stringify([{ string_list_data: [{ href: 'https://www.instagram.com/hal', value: 'hal', timestamp: 1600000000 }] }]),
    secrets: [],
  },
];

describe('privacy', () => {
  for (const f of FIXTURES) {
    it(`${f.name}: no emails, phone numbers or message text in the result`, () => {
      let result = importFile({ name: f.name, text: f.text });
      if ('needsMapping' in result) {
        result = csvToResult(result.rows, result.mapping, 'test');
      }
      const json = JSON.stringify(result as ImportResult);
      const withoutDates = json.replace(/\d{4}-\d{2}-\d{2}/g, '');
      expect(json).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
      expect(withoutDates).not.toMatch(/\+?\d[\d\s().-]{8,}\d/);
      for (const s of f.secrets) expect(json).not.toContain(s);
    });
  }
});
