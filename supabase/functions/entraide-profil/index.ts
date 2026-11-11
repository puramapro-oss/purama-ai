import { createEntraideHandler } from '../_shared/entraide-http.ts';
import { entraidePorts } from '../_shared/entraide-runtime.ts';

Deno.serve(createEntraideHandler('entraide-profil', entraidePorts));
