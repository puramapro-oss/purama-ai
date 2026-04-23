# frozen_string_literal: true
# Generate & install ESIGN_CERTS for DocuSeal PDF signing.
# Run once: docker exec -w /app docuseal bundle exec rails runner /tmp/setup-esign-certs.rb

certs = GenerateCertificate.call('Purama')

serialized = {
  'cert'    => certs[:cert].to_pem,
  'key'     => certs[:key].to_pem,
  'root_ca' => certs[:root_ca].to_pem,
  'sub_ca'  => certs[:sub_ca].to_pem
}

account = Account.first
config = EncryptedConfig.find_or_initialize_by(key: EncryptedConfig::ESIGN_CERTS_KEY, account_id: account.id)
config.value = serialized
config.save!

puts "ESIGN_CERTS saved: config_id=#{config.id}"

# Retry stuck completion jobs for latest submission
Submission.order(id: :desc).limit(3).each do |sub|
  sub.submitters.find_each do |s|
    next if CompletedSubmitter.exists?(submitter_id: s.id)
    next unless s.completed_at
    puts "Retrying completion for submitter #{s.id} (submission #{sub.id})"
    ProcessSubmitterCompletionJob.perform_async('submitter_id' => s.id)
  end
end
