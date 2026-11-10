/** Shown on SAM/CV dev pages when the app was started without SAM. */
export function SamDisabledNotice({ tool }: { tool: string }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-3 p-6 text-sm">
      <h1 className="text-lg font-medium">{tool} is turned off</h1>
      <p className="text-muted-foreground">
        This tool needs the local SAM/CV Python service, which is optional and
        only set up on some machines. Restart the app with{' '}
        <code className="rounded bg-muted px-1">npm run dev:sam</code> to use it.
      </p>
    </main>
  );
}
