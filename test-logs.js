const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

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

async function testQuery() {
   // Sign in
   const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
       email: 'test@tbm.com',
       password: 'test'
   });
   if (authError) {
      console.error("Login failed:", authError);
      return;
   }
   
   console.log("Logged in as:", authData.user.id);

   // Query
   const { data, error } = await supabase.from('tbm_logs').select('*');
   console.log("Error:", error);
   if (data) {
       console.log("Logs count:", data.length);
       if (data.length > 0) {
           console.log("First log user_id:", data[0].user_id);
       }
   }
}
testQuery();
