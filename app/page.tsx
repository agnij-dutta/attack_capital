import Link from "next/link";

export default function Home() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-gray-900 dark:to-gray-800">
      <div className="w-full max-w-md space-y-8 rounded-2xl bg-white p-8 shadow-xl dark:bg-gray-800">
        <div className="text-center">
          <h1 className="text-4xl font-bold text-gray-900 dark:text-white">
            ScribeAI
          </h1>
          <p className="mt-2 text-gray-600 dark:text-gray-400">
            AI-Powered Meeting Transcription
          </p>
        </div>
        <div className="space-y-4">
          <Link
            href="/sign-in"
            className="block w-full rounded-lg bg-indigo-600 px-4 py-3 text-center font-medium text-white transition-colors hover:bg-indigo-700"
          >
            Sign In
          </Link>
          <Link
            href="/sign-up"
            className="block w-full rounded-lg border border-gray-300 bg-white px-4 py-3 text-center font-medium text-gray-700 transition-colors hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600"
          >
            Sign Up
          </Link>
        </div>
      </div>
    </div>
  );
}
