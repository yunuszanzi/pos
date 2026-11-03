import { forwardRef, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from "react";

export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return <label className="field"><span>{label}</span>{children}</label>;
}

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  (props, ref) => <input ref={ref} className="input" {...props} />,
);

export const SelectInput = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  (props, ref) => <select ref={ref} className="input" {...props} />,
);

export function PageTitle({ title, description }: { title: string; description?: string }) {
  return <header className="page-title"><h1>{title}</h1>{description && <p>{description}</p>}</header>;
}

export function ErrorMessage({ children }: { children: ReactNode }) {
  return <p className="notice error" role="alert">{children}</p>;
}

export function SuccessMessage({ children }: { children: ReactNode }) {
  return <p className="notice success" role="status">{children}</p>;
}

export function Panel({ title, children }: { title: string; children: ReactNode }) {
  return <section className="panel"><h2>{title}</h2>{children}</section>;
}
