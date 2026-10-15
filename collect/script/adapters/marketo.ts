// Marketo forms: read the email from the form's success callback.

/* eslint-disable @typescript-eslint/no-explicit-any */
export function watchMarketo(w: any, send: (email: string, form: string) => void): void {
  let tries = 0;
  const hook = () => {
    const m = w.MktoForms2;
    if (!m || typeof m.whenReady !== "function") {
      if (++tries < 20) setTimeout(hook, 500);
      return;
    }
    m.whenReady((form: any) => {
      form.onSuccess((values: any) => {
        if (values && typeof values.Email === "string") send(values.Email, String(form.getId ? form.getId() : ""));
        // Returning nothing keeps Marketo's own redirect.
      });
    });
  };
  hook();
}
