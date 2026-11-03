import { CourseCard } from '@/components/course-card';

const COURSES = [
  { code: 'CS 106A', title: 'Programming Methodology', units: 5 },
  { code: 'CS 107', title: 'Computer Organization and Systems', units: 5 },
  { code: 'CS 161', title: 'Design and Analysis of Algorithms', units: 5 },
];

export default function Home() {
  return (
    <div>
      <h1 className="text-2xl font-semibold">Courses</h1>
      <p className="mt-2 text-sm text-muted">Pick what to take next quarter.</p>
      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        {COURSES.map((c) => (
          <CourseCard key={c.code} {...c} />
        ))}
      </div>
    </div>
  );
}
