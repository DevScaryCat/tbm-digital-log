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
  env['SUPABASE_SERVICE_ROLE_KEY']
);

async function checkData() {
   console.log("Fetching all logs using service role with select *...");
   const { data, error } = await supabase.from('tbm_logs').select('*');
   if (error) {
      console.error("Error:", error);
   } else {
      console.log(`Successfully fetched ${data.length} logs.`);
   }
}
checkData();
