import type { ButtonHTMLAttributes } from 'react';

export function Button({ className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={`inline-flex h-10 items-center rounded-md bg-brand px-4 text-sm font-medium text-white hover:opacity-90 ${className}`}
      {...props}
    />
  );
}
