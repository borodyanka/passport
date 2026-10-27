import { defineConfig } from 'vite';

// GitHub Pages project site needs /repository-name/ as the asset base.
// Vite builds on GitHub Actions; locally it uses /.
export default defineConfig({
  base: process.env.GITHUB_ACTIONS && process.env.GITHUB_REPOSITORY
    ? `/${process.env.GITHUB_REPOSITORY.split('/')[1]}/`
    : '/',
});
