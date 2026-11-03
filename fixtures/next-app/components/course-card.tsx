import { Button } from '@/components/ui/button';

export function CourseCard({ code, title, units }: { code: string; title: string; units: number }) {
  return (
    <div className="rounded-lg border border-muted/20 p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-muted">{code}</p>
      <h2 className="mt-1 text-lg font-semibold">{title}</h2>
      <p className="mt-1 text-sm text-muted">{units} units</p>
      <Button className="mt-4">Add to plan</Button>
    </div>
  );
}
