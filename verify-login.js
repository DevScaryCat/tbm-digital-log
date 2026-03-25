const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

// Parse .env.local manually
const envFile = fs.readFileSync('.env.local', 'utf8');
const env = {};
envFile.split('\n').forEach(line => {
  const match = line.match(/^([^=]+)=(.*)$/);
  if (match) {
    env[match[1]] = match[2];
  }
});

const supabase = createClient(
  env['NEXT_PUBLIC_SUPABASE_URL'],
  env['NEXT_PUBLIC_SUPABASE_ANON_KEY']
);

async function verify() {
   const { data, error } = await supabase.auth.signInWithPassword({
       email: 'test@tbm.com',
       password: 'test'
   });
   console.log("Error:", error ? error.message : "None");
   console.log("Logged in:", data?.user ? "YES" : "NO");
}
verify();
