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
  env['SUPABASE_SERVICE_ROLE_KEY']
);

async function updateTestUser() {
  console.log("Updating user metadata...");
  
  // We can just update user metadata directly
  const { data, error } = await supabase.auth.admin.updateUserById(
    '8aa2c035-77b4-4d9f-867a-e87805827e4f',
    { user_metadata: { company_name: '테스트', full_name: '테스트' } }
  );

  if (error) {
    console.error("Error updating user:", error);
  } else {
    console.log("Updated metadata successfully:", data.user.user_metadata);
  }
}

updateTestUser();
