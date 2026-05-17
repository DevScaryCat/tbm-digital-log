const fs = require('fs');
const env = fs.readFileSync('.env.local', 'utf8');
const urlMatch = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/);
const keyMatch = env.match(/SUPABASE_SERVICE_ROLE_KEY=(.+)/);

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(urlMatch[1].trim(), keyMatch[1].trim());

async function migrate() {
  console.log("Fetching users...");
  const { data: { users }, error } = await supabase.auth.admin.listUsers();
  if (error) {
    console.error("Error fetching users:", error);
    return;
  }
  
  let count = 0;
  for (const user of users) {
    if (user.user_metadata && user.user_metadata.worker_type === '관리감독자') {
      const newMetadata = {
        ...user.user_metadata,
        worker_type: '현장 근로자 (비사무직)'
      };
      
      const { error: updateError } = await supabase.auth.admin.updateUserById(
        user.id,
        { user_metadata: newMetadata }
      );
      
      if (updateError) {
        console.error(`Error updating user ${user.id}:`, updateError);
      } else {
        console.log(`Updated user ${user.id}`);
        count++;
      }
    }
  }
  console.log(`Migration complete. Updated ${count} users.`);
}

migrate();
