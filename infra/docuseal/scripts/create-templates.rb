# frozen_string_literal: true
# DocuSeal template creator — bypass Pro API, direct ActiveRecord.
# Usage: docker exec -w /app docuseal bundle exec rails runner /tmp/create-templates.rb
# Requires PDFs already generated at /tmp/docuseal-upload/<slug>.pdf

require 'json'
require 'securerandom'

PDF_DIR = '/tmp/docuseal-upload'

TEMPLATES = [
  { slug: 'ambassadeur-bronze',   name: 'Ambassadeur Bronze',   tier: 'bronze',  rate: 10,  months: 12 },
  { slug: 'ambassadeur-argent',   name: 'Ambassadeur Argent',   tier: 'argent',  rate: 15,  months: 12 },
  { slug: 'ambassadeur-or',       name: 'Ambassadeur Or',       tier: 'or',      rate: 20,  months: 12 },
  { slug: 'ambassadeur-platine',  name: 'Ambassadeur Platine',  tier: 'platine', rate: 25,  months: 24 },
  { slug: 'ambassadeur-eternel',  name: 'Ambassadeur Éternel (héréditaire)', tier: 'eternel', rate: 30, months: 1200 },
  { slug: 'partenariat-business', name: 'Partenariat Business', tier: nil, rate: nil, months: 12 },
  { slug: 'territoire-purama',    name: 'Convention Territoire Purama', tier: nil, rate: nil, months: 36 },
  { slug: 'prestation-freelance', name: 'Contrat Prestation Freelance', tier: nil, rate: nil, months: 3 }
]

account = Account.first
user = User.where(account_id: account.id, role: :admin).first
abort 'Admin account/user missing' unless account && user

results = []

TEMPLATES.each do |tpl|
  pdf_path = File.join(PDF_DIR, "#{tpl[:slug]}.pdf")
  unless File.exist?(pdf_path)
    puts "SKIP #{tpl[:slug]} — missing #{pdf_path}"
    next
  end

  docuseal_name = "Purama — #{tpl[:name]}"

  # Idempotency: delete existing by name
  existing = Template.where(account_id: account.id, name: docuseal_name).all
  if existing.any?
    existing.each { |t| t.destroy }
    puts "↻ Deleted #{existing.count} existing #{tpl[:slug]}"
  end

  # Read PDF and create blob
  pdf_data = File.read(pdf_path)
  sha256 = Base64.urlsafe_encode64(Digest::SHA256.digest(pdf_data))

  blob = ActiveStorage::Blob.create_and_upload!(
    io: StringIO.new(pdf_data),
    filename: "#{tpl[:slug]}.pdf",
    metadata: { identified: true, analyzed: true, pdf: {}, sha256: sha256 },
    content_type: 'application/pdf'
  )

  # UUIDs for submitters and fields
  submitter_ambassadeur_uuid = SecureRandom.uuid
  submitter_purama_uuid = SecureRandom.uuid
  sig_field_ambassadeur_uuid = SecureRandom.uuid
  sig_field_purama_uuid = SecureRandom.uuid

  # Date field for ambassadeur
  date_field_uuid = SecureRandom.uuid

  # Build schema (document reference) and fields (signature positions)
  attachment_uuid = SecureRandom.uuid

  schema = [{
    'attachment_uuid' => attachment_uuid,
    'name' => tpl[:name]
  }]

  # Signature fields positioned on last page (approx lower third)
  # areas: page index 0-based, x/y/w/h in relative coordinates (0..1)
  fields = [
    {
      'uuid' => sig_field_purama_uuid,
      'submitter_uuid' => submitter_purama_uuid,
      'name' => 'Signature Purama',
      'type' => 'signature',
      'required' => true,
      'areas' => [{
        'page' => -1,      # last page (DocuSeal convention)
        'attachment_uuid' => attachment_uuid,
        'x' => 0.08, 'y' => 0.78, 'w' => 0.35, 'h' => 0.06
      }]
    },
    {
      'uuid' => sig_field_ambassadeur_uuid,
      'submitter_uuid' => submitter_ambassadeur_uuid,
      'name' => 'Signature Ambassadeur',
      'type' => 'signature',
      'required' => true,
      'areas' => [{
        'page' => -1,
        'attachment_uuid' => attachment_uuid,
        'x' => 0.55, 'y' => 0.78, 'w' => 0.35, 'h' => 0.06
      }]
    },
    {
      'uuid' => date_field_uuid,
      'submitter_uuid' => submitter_ambassadeur_uuid,
      'name' => 'Date signature',
      'type' => 'date',
      'required' => true,
      'default_value' => '{{date}}',
      'areas' => [{
        'page' => -1,
        'attachment_uuid' => attachment_uuid,
        'x' => 0.55, 'y' => 0.86, 'w' => 0.2, 'h' => 0.03
      }]
    }
  ]

  submitters = [
    { 'name' => 'Purama', 'uuid' => submitter_purama_uuid },
    { 'name' => 'Ambassadeur', 'uuid' => submitter_ambassadeur_uuid }
  ]

  # Create Template
  template = Template.new(
    account_id: account.id,
    author_id: user.id,
    name: docuseal_name,
    slug: SecureRandom.urlsafe_base64(16),
    source: :api,
    external_id: tpl[:slug],
    schema: schema,
    fields: fields,
    submitters: submitters,
    preferences: {}
  )

  # Attach document (will get UUID via metadata)
  doc_attachment = template.documents_attachments.build(
    blob: blob,
    name: 'documents'
  )

  template.save!

  # After save, attachment has an ID — fetch it and update schema to reference by blob UUID
  doc = template.documents.first
  if doc
    # Sync attachment_uuid in schema/fields to match the document's uuid
    doc_uuid = doc.uuid rescue doc.id.to_s
    template.schema = [{ 'attachment_uuid' => doc_uuid, 'name' => tpl[:name] }]
    template.fields = template.fields.map do |f|
      f.merge('areas' => f['areas'].map { |a| a.merge('attachment_uuid' => doc_uuid) })
    end
    template.save!

    # Process PDF (generate preview images, detect fields, etc)
    begin
      Templates::ProcessDocument.call(doc, pdf_data, extract_fields: false)
    rescue => e
      puts "  ProcessDocument warn for #{tpl[:slug]}: #{e.message}"
    end
  end

  puts "✓ #{tpl[:slug]} → Template ID #{template.id}"
  results << { slug: tpl[:slug], id: template.id, docuseal_template_id: template.id }
end

puts ""
puts "=== MAPPING (slug → docuseal_template_id) ==="
puts JSON.generate(results.map { |r| [r[:slug], r[:id]] }.to_h)
puts "=== DONE — #{results.size}/#{TEMPLATES.size} ==="
