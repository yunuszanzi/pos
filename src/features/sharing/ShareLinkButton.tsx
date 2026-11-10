import { useState } from "react";
import { whatsappLink, whatsappShareLink } from "../../../shared/khata";
import { createDocumentShare, revokeDocumentShares, type ShareType } from "../../api/sharesApi";
import { ErrorMessage, TextInput } from "../../app/FormElements";

/**
 * Shares a document by link. Pressing "Share link" makes (or finds) the link; then the person can copy it or send it on WhatsApp to
 * the customer's own number (or whoever they pick). The link opens the document on any phone with no sign-in, until it expires
 * or is stopped. It is two steps on purpose: a browser blocks a window opened after waiting for the server.
 */
export function ShareLinkButton({ type, id, phone, message }: { type: ShareType; id: string; phone?: string; message: (url: string) => string }) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [stopped, setStopped] = useState(false);

  async function make() {
    setBusy(true);
    setError("");
    setStopped(false);
    try {
      const share = await createDocumentShare(type, id);
      setUrl(`${window.location.origin}${share.path}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not make the link");
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    setBusy(true);
    setError("");
    try {
      await revokeDocumentShares(type, id);
      setUrl("");
      setStopped(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not stop sharing");
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  if (!url) {
    return <>
      <button className="button secondary" disabled={busy} onClick={() => void make()}>{busy ? "Making the link…" : "Share link"}</button>
      {stopped && <span className="muted"> The link no longer works.</span>}
      {error && <ErrorMessage>{error}</ErrorMessage>}
    </>;
  }
  const text = message(url);
  return <div className="stack" aria-label="Share link">
    <TextInput aria-label="Link to share" readOnly value={url} onFocus={(event) => event.currentTarget.select()} />
    <div className="button-row">
      <a className="button primary" href={(phone && whatsappLink(phone, text)) || whatsappShareLink(text)} target="_blank" rel="noreferrer">Send on WhatsApp</a>
      <button className="button secondary" onClick={() => void copy()}>{copied ? "Copied" : "Copy link"}</button>
      <button className="button secondary" disabled={busy} onClick={() => void stop()}>Stop sharing</button>
    </div>
    <p className="muted">Anyone with this link can read this document, without signing in, for 30 days or until you stop sharing.</p>
    {error && <ErrorMessage>{error}</ErrorMessage>}
  </div>;
}
