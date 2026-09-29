import buildApp from './app';

const start = async (): Promise<void> => {
  const app = buildApp();
  const port = Number(process.env.PORT) || 8080;
  const host = '0.0.0.0';

  try {
    await app.listen({ port, host });
    app.log.info(`Server listening on ${port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

if (require.main === module) {
  start();
}

export { start };
