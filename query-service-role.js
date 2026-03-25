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
  env['SUPABASE_SERVICE_ROLE_KEY'] // Service role bypasses RLS
);

async function checkData() {
   console.log("Fetching all logs using service role...");
   const { data, error } = await supabase.from('tbm_logs').select('id, user_id, company_name');
   if (error) {
      console.error("Error:", error);
   } else {
      console.log(`Successfully fetched ${data.length} logs.`);
      const testLogs = data.filter(d => d.user_id === '8aa2c035-77b4-4d9f-867a-e87805827e4f');
      console.log("Test user logs:", testLogs.length);
      console.log(testLogs);
   }
}
checkData();
