// Feedback form: the same Formspree setup as Marauder's Map, sent in the background so the
// person sees a real success or error. Only what they type is sent; the map never is.
// The page's CSP allows exactly this one address (see PUBLIC_CSP in vite.config.ts).

export const FEEDBACK_ACTION = 'https://formspree.io/f/xnpjaklb';

export function mountFeedback(button: HTMLElement, dialog: HTMLDialogElement) {
  dialog.innerHTML = `
    <form method="dialog" class="feedback-form">
      <header><h2>Send feedback</h2><button type="button" class="close" data-close aria-label="Close">×</button></header>
      <input type="hidden" name="_subject" value="Network Scope feedback" />
      <input type="hidden" name="site" value="Network Scope" />
      <input type="text" name="_gotcha" class="honey" tabindex="-1" autocomplete="off" aria-hidden="true" />
      <label><span>What’s working, what isn’t, what’s missing?</span>
        <textarea name="message" required rows="5" maxlength="4000" placeholder="Anything helps, even one line."></textarea></label>
      <label><span>Your email, only if you’d like a reply</span>
        <input type="email" name="email" autocomplete="email" /></label>
      <p class="fine">Only what you type here is sent, to the site’s maintainer through Formspree. Your map is never included.</p>
      <div class="row"><button type="submit" class="primary">Send</button><span class="status" role="status"></span></div>
    </form>`;
  const form = dialog.querySelector('form')!;
  const status = dialog.querySelector<HTMLElement>('.status')!;
  const send = form.querySelector<HTMLButtonElement>('[type=submit]')!;

  button.addEventListener('click', () => { status.textContent = ''; dialog.showModal(); form.querySelector('textarea')!.focus(); });
  dialog.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('[data-close]') || e.target === dialog) dialog.close();
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    send.disabled = true;
    status.textContent = 'Sending…';
    try {
      const res = await fetch(FEEDBACK_ACTION, { method: 'POST', body: new FormData(form), headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(String(res.status));
      form.reset();
      status.textContent = 'Thanks, it’s been sent.';
      setTimeout(() => dialog.close(), 1400);
    } catch {
      status.textContent = 'That didn’t go through. Try again in a minute.';
    } finally {
      send.disabled = false;
    }
  });
}
