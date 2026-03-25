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

async function checkDatabase() {
  console.log("Checking RLS Policies for tbm_logs...");
  
  // Query pg_policies to see exactly what is set
  const { data: policies, error: policyError } = await supabase.rpc('get_policies'); 
  
  // If RPC is not available, we can try to query directly via SQL-like interface if possible, 
  // but since standard PostgREST doesn't expose system tables easily without RPC, 
  // we'll try to insert a dummy record and see if it fails for the test user.
  
  console.log("Fetching logs for test user ID: 8aa2c035-77b4-4d9f-867a-e87805827e4f");
  const { data: logs, error: logError } = await supabase
    .from('tbm_logs')
    .select('*')
    .eq('user_id', '8aa2c035-77b4-4d9f-867a-e87805827e4f');

  if (logError) {
    console.error("Error fetching logs:", logError);
  } else {
    console.log(`Found ${logs.length} logs for the test user.`);
    if (logs.length > 0) {
        console.log("Sample log sample:", logs[0]);
    }
  }

  // Attempt to check if there is any company filtering issue
  const { data: allLogs, error: anyError } = await supabase
    .from('tbm_logs')
    .select('user_id, company_name')
    .limit(5);
  
  console.log("All logs distribution:", allLogs);
}

checkDatabase();
