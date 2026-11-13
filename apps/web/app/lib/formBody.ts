/** What a form action answers, with a 400, when its body is not a form. */
export const UNREADABLE_FORM = "That form could not be read. Please refresh the page and try again.";

/**
 * A request body as form data, or null when it is not a form: JSON, plain
 * text, a multipart body that does not parse, or no body at all.
 * request.formData() throws on each of those, and a thrown error is a 500 on
 * the site and an error alert to the owner. Every form action reads its body
 * through this and answers null with a 400 (formActionsRejectNonForm.test.ts
 * holds the routes to it).
 */
export async function readFormData(request: Request): Promise<FormData | null> {
  try {
    return await request.formData();
  } catch {
    return null;
  }
}
