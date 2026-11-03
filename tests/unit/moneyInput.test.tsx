import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MoneyInput } from "../../src/app/MoneyInput";

function Controlled({ initial = "" }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  return <>
    <MoneyInput aria-label="Price" value={value} onChange={(event) => setValue(event.target.value)} />
    <output data-testid="state">{value}</output>
    <button>elsewhere</button>
  </>;
}

async function typeAndLeave(text: string) {
  const user = userEvent.setup();
  render(<Controlled />);
  const input = screen.getByLabelText("Price") as HTMLInputElement;
  if (text) await user.type(input, text);
  await user.click(screen.getByText("elsewhere"));
  return { input, state: screen.getByTestId("state").textContent };
}

afterEach(cleanup);

describe("MoneyInput", () => {
  it.each([
    ["3.2", "3.20"],
    ["5", "5.00"],
    ["1,234.5", "1234.50"],
    [".5", "0.50"],
    ["0", "0.00"],
    ["12.34", "12.34"],
    [" 7 ", "7.00"],
  ])("shows %s as %s once you leave the box", async (typed, shown) => {
    const { input, state } = await typeAndLeave(typed);
    expect(input.value).toBe(shown);
    expect(state).toBe(shown); // the form's own state follows, not just the screen
    expect(input.getAttribute("aria-invalid")).toBeNull();
  });

  it.each(["3.456", "abc", "1.2.3", "5%"])("leaves %s as typed and marks it invalid", async (typed) => {
    const { input, state } = await typeAndLeave(typed);
    expect(input.value).toBe(typed);
    expect(state).toBe(typed);
    expect(input.getAttribute("aria-invalid")).toBe("true");
  });

  it("leaves an empty box empty", async () => {
    const { input } = await typeAndLeave("");
    expect(input.value).toBe("");
    expect(input.getAttribute("aria-invalid")).toBeNull();
  });

  it("clears the invalid mark when the person corrects it", async () => {
    const user = userEvent.setup();
    render(<Controlled />);
    const input = screen.getByLabelText("Price") as HTMLInputElement;
    await user.type(input, "3.456");
    await user.click(screen.getByText("elsewhere"));
    expect(input.getAttribute("aria-invalid")).toBe("true");
    await user.clear(input);
    await user.type(input, "3.45");
    expect(input.getAttribute("aria-invalid")).toBeNull();
  });

  it("works with React Hook Form: the submitted value has 2 decimals", async () => {
    const submitted = vi.fn();
    function Form() {
      const { register, handleSubmit } = useForm({ defaultValues: { cost: "" } });
      return <form onSubmit={handleSubmit(submitted)}>
        <MoneyInput aria-label="Cost" {...register("cost")} />
        <button>save</button>
      </form>;
    }
    const user = userEvent.setup();
    render(<Form />);
    await user.type(screen.getByLabelText("Cost"), "3.2");
    await user.click(screen.getByText("save"));
    expect(submitted).toHaveBeenCalledTimes(1);
    expect(submitted.mock.calls[0][0]).toEqual({ cost: "3.20" });
  });

  it("starts from a saved amount and keeps it at 2 decimals", () => {
    render(<Controlled initial="1250.50" />);
    expect((screen.getByLabelText("Price") as HTMLInputElement).value).toBe("1250.50");
  });
});
