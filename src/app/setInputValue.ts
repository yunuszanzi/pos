/**
 * React only notices a value change that comes through its own input events, and React Hook Form listens to the same
 * events. Setting the value the way the browser does, then firing "input", updates the screen and the form together.
 */
export function setInputValueLikeTheBrowser(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
